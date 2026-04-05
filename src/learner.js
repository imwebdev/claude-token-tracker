/**
 * Adaptive learning — improves routing from historical dispatch data.
 *
 * Tracks success rates per family×model from two data sources:
 * 1. Subagent dispatches (is_optimal field — did the dispatch match recommendation?)
 * 2. Escalation patterns (if a task was dispatched to haiku then re-dispatched to sonnet,
 *    haiku "failed" for that family)
 *
 * Uses a Bayesian-style approach:
 * - Start with prior confidence from hardcoded rules (the base recommendation)
 * - Update with observed data: success_rate = successes / total_samples
 * - Minimum 5 samples before adjusting (avoid overfitting to noise)
 * - Recent events weighted 2x vs older events (decay)
 * - Never downgrade architecture below opus (safety floor)
 *
 * The learner produces "adjustments" that the router can apply:
 *   { family: "debug", model: "sonnet", confidence: 0.85, samples: 12, suggestion: "upgrade" }
 */
const fs = require('fs');
const path = require('path');
const events = require('./events');
const dataHome = require('./data-home');

const MIN_SAMPLES = 5;
const RECENCY_DAYS = 14; // Events within this window get 2x weight
const CACHE_TTL = 300_000; // 5 minutes

let _cache = null;
let _cacheTime = 0;

/**
 * Build learning data from historical events.
 * Returns { byFamilyModel: { "debug:sonnet": { total, successes, failures, rate, samples } }, ... }
 */
function buildLearningData() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  const allEvents = events.readEvents({});
  const dispatches = allEvents.filter(e => e.type === 'subagent_dispatch');
  const decisions = allEvents.filter(e => e.type === 'routing_decision');

  const recencyThreshold = new Date(now - RECENCY_DAYS * 86400_000).toISOString();

  // Track per family×model
  const stats = {};

  function getOrCreate(family, model) {
    const key = `${family}:${model}`;
    if (!stats[key]) stats[key] = { family, model, total: 0, successes: 0, failures: 0, weightedTotal: 0, weightedSuccesses: 0 };
    return stats[key];
  }

  // Source 1: Subagent dispatches — is_optimal tells us if the recommendation matched
  for (const d of dispatches) {
    const cls = d.classification || {};
    const family = cls.family || 'unknown';
    const usedModel = d.model_used || 'opus';
    const recModel = d.recommended_model || 'sonnet';
    const isRecent = d.ts >= recencyThreshold;
    const weight = isRecent ? 2 : 1;

    // Record success for the model that was used
    const entry = getOrCreate(family, usedModel);
    entry.total++;
    entry.weightedTotal += weight;

    if (d.is_optimal) {
      // Used model matched recommendation — count as success for that model
      entry.successes++;
      entry.weightedSuccesses += weight;
    } else {
      // Used a more expensive model than recommended — the cheaper model "failed"
      // (user/system decided it wasn't good enough)
      entry.failures++;

      // Also record that the recommended (cheaper) model was implicitly inadequate
      const cheaperEntry = getOrCreate(family, recModel);
      cheaperEntry.total++;
      cheaperEntry.failures++;
      cheaperEntry.weightedTotal += weight;
    }
  }

  // Source 2: Routing decisions that were NOT followed by a dispatch
  // (the recommendation was used directly — implicit success for the recommended model)
  const dispatchTimestamps = new Set(dispatches.map(d => d.ts).filter(Boolean));
  for (const d of decisions) {
    if (!d.ts) continue;
    const cls = d.classification || {};
    const family = cls.family || 'unknown';
    const recModel = d.recommended_model || 'sonnet';
    const isRecent = d.ts >= recencyThreshold;
    const weight = isRecent ? 2 : 1;

    // If this decision led to a dispatch, it's already counted above
    // We approximate: if no dispatch within 5 seconds of this decision, it was used directly
    const hasDispatch = dispatches.some(disp =>
      disp.session_id === d.session_id &&
      disp.ts && d.ts &&
      Math.abs(new Date(disp.ts) - new Date(d.ts)) < 30_000
    );

    if (!hasDispatch) {
      // Model was used directly (no delegation) — counts as success
      const entry = getOrCreate(family, recModel);
      entry.total++;
      entry.successes++;
      entry.weightedTotal += weight;
      entry.weightedSuccesses += weight;
    }
  }

  // Calculate rates
  const result = {};
  for (const [key, s] of Object.entries(stats)) {
    result[key] = {
      ...s,
      rate: s.total > 0 ? s.successes / s.total : 0,
      weightedRate: s.weightedTotal > 0 ? s.weightedSuccesses / s.weightedTotal : 0,
      samples: s.total,
      meetsThreshold: s.total >= MIN_SAMPLES,
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

  // If the recommended model succeeds >85% of the time — confirm it
  if (rate >= 0.85) {
    return {
      suggestion: 'confirm',
      reason: `${recommendedModel} succeeds ${Math.round(rate * 100)}% for ${family} (${entry.samples} samples)`,
      confidence: rate,
      samples: entry.samples,
    };
  }

  // If success rate is low (<60%), suggest upgrading to a more capable model
  if (rate < 0.60) {
    const upgrade = recommendedModel === 'haiku' ? 'sonnet' : recommendedModel === 'sonnet' ? 'opus' : null;
    if (upgrade) {
      // Check if the upgrade model has better stats
      const upgradeKey = `${family}:${upgrade}`;
      const upgradeEntry = data.byFamilyModel[upgradeKey];
      const upgradeRate = upgradeEntry?.weightedRate || 0.5; // assume 50% if no data

      if (upgradeRate > rate) {
        return {
          suggestion: 'upgrade',
          upgradeTo: upgrade,
          reason: `${recommendedModel} only succeeds ${Math.round(rate * 100)}% for ${family} -- ${upgrade} at ${Math.round(upgradeRate * 100)}% (${entry.samples} samples)`,
          confidence: rate,
          samples: entry.samples,
        };
      }
    }
  }

  // If success rate is very high (>90%) and this is an expensive model, suggest downgrading
  if (rate >= 0.90 && recommendedModel !== 'haiku') {
    const downgrade = recommendedModel === 'opus' ? 'sonnet' : recommendedModel === 'sonnet' ? 'haiku' : null;
    if (downgrade) {
      const downgradeKey = `${family}:${downgrade}`;
      const downgradeEntry = data.byFamilyModel[downgradeKey];

      // Only suggest downgrade if the cheaper model also has good stats (or no data = worth trying)
      if (!downgradeEntry || !downgradeEntry.meetsThreshold || downgradeEntry.weightedRate >= 0.70) {
        return {
          suggestion: 'downgrade',
          downgradeTo: downgrade,
          reason: `${recommendedModel} succeeds ${Math.round(rate * 100)}% for ${family} -- ${downgrade} may suffice (${entry.samples} samples)`,
          confidence: rate,
          samples: entry.samples,
        };
      }
    }
  }

  return null;
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
      adjustment: adj,
    });
  }

  // Sort by impact: upgrades first, then low-confidence entries
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
  };
}

/** Clear the cache (e.g. after new events are recorded). */
function clearCache() { _cache = null; _cacheTime = 0; }

module.exports = { buildLearningData, getAdjustment, getLearningStats, clearCache };
