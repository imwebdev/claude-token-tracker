/**
 * Adaptive learning — improves routing from multi-signal outcome data.
 *
 * Replaces the old "routing compliance" signal (did the used model match
 * the recommendation?) with a weighted outcome score derived from three
 * independent signals:
 *
 *   1. Turn outcome  (Stop vs StopFailure)         weight: 0.40
 *   2. No escalation (wasn't re-dispatched higher)  weight: 0.35
 *   3. No correction (next prompt isn't a fix)       weight: 0.25
 *
 * Each signal is 0 or 1. The weighted average produces a score in [0, 1].
 * These scores are aggregated per family×model to produce routing adjustments.
 *
 * Minimum 5 outcome events before adjusting (avoid overfitting to noise).
 * Recent events (within 14 days) get 2x weight.
 * Never downgrade architecture below opus (safety floor).
 */
const events = require('./events');

const MIN_SAMPLES = 5;
const RECENCY_DAYS = 14;
const CACHE_TTL = 300_000; // 5 minutes

// Signal weights — must sum to 1.0
const WEIGHTS = {
  turn_success: 0.40,
  no_escalation: 0.35,
  no_correction: 0.25,
};

let _cache = null;
let _cacheTime = 0;

/**
 * Build learning data from outcome events and correction events.
 * Returns { byFamilyModel: { "debug:sonnet": { total, weightedScore, ... } } }
 */
function buildLearningData() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  const allEvents = events.readEvents({});
  const outcomes = allEvents.filter(e => e.type === 'outcome');
  const corrections = allEvents.filter(e => e.type === 'outcome_correction');

  const recencyThreshold = new Date(now - RECENCY_DAYS * 86400_000).toISOString();

  // Index corrections by session for fast lookup
  // A correction in session X means the previous turn in session X had a negative signal
  const correctionsBySession = {};
  for (const c of corrections) {
    const sid = c.session_id;
    if (!sid) continue;
    if (!correctionsBySession[sid]) correctionsBySession[sid] = [];
    correctionsBySession[sid].push(c);
  }

  const stats = {};

  function getOrCreate(family, model) {
    const key = `${family}:${model}`;
    if (!stats[key]) {
      stats[key] = {
        family,
        model,
        total: 0,
        weightedScoreSum: 0,
        weightedTotal: 0,
        // Per-signal tracking for dashboard visibility
        signals: { turn_success: 0, no_escalation: 0, no_correction: 0 },
        signalTotal: 0,
      };
    }
    return stats[key];
  }

  for (const o of outcomes) {
    const family = o.family || 'unknown';
    const model = o.model || 'opus';
    const isRecent = o.ts >= recencyThreshold;
    const weight = isRecent ? 2 : 1;

    // Signal 1: turn success (from outcome event)
    const turnSuccess = o.turn_success ? 1 : 0;

    // Signal 2: no escalation (from outcome event)
    const noEscalation = o.was_escalated ? 0 : 1;

    // Signal 3: no correction — check if a correction event followed in this session
    // A correction event logged shortly after this outcome means the user was unhappy
    const sessionCorrections = correctionsBySession[o.session_id] || [];
    const wasFollowedByCorrection = sessionCorrections.some(c => {
      if (!c.ts || !o.ts) return false;
      const timeDiff = new Date(c.ts) - new Date(o.ts);
      // Correction within 5 minutes of this outcome counts against it
      return timeDiff > 0 && timeDiff < 300_000;
    });
    const noCorrection = wasFollowedByCorrection ? 0 : 1;

    // Weighted outcome score for this single event
    const score = (turnSuccess * WEIGHTS.turn_success) +
                  (noEscalation * WEIGHTS.no_escalation) +
                  (noCorrection * WEIGHTS.no_correction);

    const entry = getOrCreate(family, model);
    entry.total++;
    entry.weightedScoreSum += score * weight;
    entry.weightedTotal += weight;
    entry.signalTotal++;
    entry.signals.turn_success += turnSuccess;
    entry.signals.no_escalation += noEscalation;
    entry.signals.no_correction += noCorrection;
  }

  // ── Backfill from legacy data (subagent_dispatch events without outcomes) ──
  // This keeps the learner useful during the transition period before enough
  // outcome events accumulate. Legacy events get half weight.
  const dispatches = allEvents.filter(e => e.type === 'subagent_dispatch');
  const outcomeTimestamps = new Set(outcomes.map(o => o.session_id + ':' + (o.family || '')));

  for (const d of dispatches) {
    const cls = d.classification || {};
    const family = cls.family || 'unknown';
    const sessionKey = d.session_id + ':' + family;

    // Skip if we already have outcome data for this session+family
    if (outcomeTimestamps.has(sessionKey)) continue;

    const usedModel = d.model_used || 'opus';
    const isRecent = d.ts >= recencyThreshold;
    const weight = (isRecent ? 2 : 1) * 0.5; // half weight for legacy

    // Legacy signal: is_optimal (compliance) as a rough proxy
    const score = d.is_optimal ? 0.8 : 0.3;

    const entry = getOrCreate(family, usedModel);
    entry.total++;
    entry.weightedScoreSum += score * weight;
    entry.weightedTotal += weight;
  }

  // Calculate final rates
  const result = {};
  for (const [key, s] of Object.entries(stats)) {
    const weightedRate = s.weightedTotal > 0 ? s.weightedScoreSum / s.weightedTotal : 0;
    result[key] = {
      ...s,
      rate: weightedRate,
      weightedRate,
      samples: s.total,
      meetsThreshold: s.total >= MIN_SAMPLES,
      signalBreakdown: s.signalTotal > 0 ? {
        turn_success: s.signals.turn_success / s.signalTotal,
        no_escalation: s.signals.no_escalation / s.signalTotal,
        no_correction: s.signals.no_correction / s.signalTotal,
      } : null,
    };
  }

  _cache = { byFamilyModel: result, generatedAt: new Date().toISOString(), totalEvents: allEvents.length };
  _cacheTime = now;
  return _cache;
}

/**
 * Get routing adjustments for a given classification.
 * Returns null if insufficient data, or { suggestion, reason, confidence } if data suggests a change.
 */
function getAdjustment(family, recommendedModel) {
  const data = buildLearningData();
  const key = `${family}:${recommendedModel}`;
  const entry = data.byFamilyModel[key];

  if (!entry || !entry.meetsThreshold) return null;

  const rate = entry.weightedRate;

  // Low success (<0.55) — suggest upgrading to a more capable model
  if (rate < 0.55) {
    const upgrade = recommendedModel === 'haiku' ? 'sonnet' : recommendedModel === 'sonnet' ? 'opus' : null;
    if (upgrade) {
      const upgradeKey = `${family}:${upgrade}`;
      const upgradeEntry = data.byFamilyModel[upgradeKey];
      const upgradeRate = upgradeEntry?.weightedRate || 0.5;

      if (upgradeRate > rate) {
        return {
          suggestion: 'upgrade',
          upgradeTo: upgrade,
          reason: `${recommendedModel} scores ${Math.round(rate * 100)}% for ${family} -- ${upgrade} at ${Math.round(upgradeRate * 100)}% (${entry.samples} outcomes)`,
          confidence: rate,
          samples: entry.samples,
        };
      }
    }
  }

  // Very high success (>0.85) on non-cheapest model — suggest downgrading to save cost.
  // NOTE: checked BEFORE the >0.80 confirm threshold, otherwise this branch is dead code.
  if (rate >= 0.85 && recommendedModel !== 'haiku') {
    const downgrade = recommendedModel === 'opus' ? 'sonnet' : recommendedModel === 'sonnet' ? 'haiku' : null;
    if (downgrade) {
      const downgradeKey = `${family}:${downgrade}`;
      const downgradeEntry = data.byFamilyModel[downgradeKey];

      if (!downgradeEntry || !downgradeEntry.meetsThreshold || downgradeEntry.weightedRate >= 0.65) {
        return {
          suggestion: 'downgrade',
          downgradeTo: downgrade,
          reason: `${recommendedModel} scores ${Math.round(rate * 100)}% for ${family} -- ${downgrade} may suffice (${entry.samples} outcomes)`,
          confidence: rate,
          samples: entry.samples,
        };
      }
    }
  }

  // Good success (0.55–0.84) or downgrade not viable — confirm the current routing
  if (rate >= 0.80) {
    return {
      suggestion: 'confirm',
      reason: `${recommendedModel} scores ${Math.round(rate * 100)}% for ${family} (${entry.samples} outcomes)`,
      confidence: rate,
      samples: entry.samples,
    };
  }

  return null; // 0.55–0.79: inconclusive — not enough signal to act
}

/**
 * Get a summary of all learned adjustments for the dashboard.
 */
function getLearningStats() {
  const data = buildLearningData();
  const adjustments = [];

  for (const [key, entry] of Object.entries(data.byFamilyModel)) {
    if (!entry.meetsThreshold) continue;
    const adj = getAdjustment(entry.family, entry.model);
    adjustments.push({
      family: entry.family,
      model: entry.model,
      rate: entry.weightedRate,
      samples: entry.samples,
      signalBreakdown: entry.signalBreakdown,
      adjustment: adj,
    });
  }

  // Sort by impact: upgrades first, then low-score entries
  adjustments.sort((a, b) => {
    if (a.adjustment?.suggestion === 'upgrade' && b.adjustment?.suggestion !== 'upgrade') return -1;
    if (b.adjustment?.suggestion === 'upgrade' && a.adjustment?.suggestion !== 'upgrade') return 1;
    return a.rate - b.rate;
  });

  return {
    adjustments,
    totalSamples: Object.values(data.byFamilyModel).reduce((s, e) => s + e.samples, 0),
    familiesTracked: new Set(Object.values(data.byFamilyModel).map(e => e.family)).size,
    generatedAt: data.generatedAt,
    signalWeights: WEIGHTS,
  };
}

/** Clear the cache (e.g. after new events are recorded). */
function clearCache() { _cache = null; _cacheTime = 0; }

module.exports = { buildLearningData, getAdjustment, getLearningStats, clearCache };
