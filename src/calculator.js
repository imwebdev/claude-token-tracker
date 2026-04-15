/**
 * Token cost calculator based on Anthropic pricing.
 * Prices in USD per million tokens.
 */

const PRICING = {
  'claude-opus-4-6': {
    input: 15.00,
    output: 75.00,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  'claude-opus-4-5-20251101': {
    input: 15.00,
    output: 75.00,
    cacheRead: 1.50,
    cacheWrite: 18.75,
  },
  'claude-sonnet-4-5-20250929': {
    input: 3.00,
    output: 15.00,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-sonnet-4-6': {
    input: 3.00,
    output: 15.00,
    cacheRead: 0.30,
    cacheWrite: 3.75,
  },
  'claude-haiku-4-5-20251001': {
    input: 1.00,
    output: 5.00,
    cacheRead: 0.10,
    cacheWrite: 1.25,
  },
};

// Map short names to full model IDs
const MODEL_ALIASES = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function getModelPrice(modelId) {
  if (!modelId) return PRICING['claude-opus-4-6'];
  // Try exact match first
  if (PRICING[modelId]) return PRICING[modelId];
  // Try alias
  if (MODEL_ALIASES[modelId] && PRICING[MODEL_ALIASES[modelId]]) {
    return PRICING[MODEL_ALIASES[modelId]];
  }
  // Fuzzy match
  if (modelId.includes('opus')) return PRICING['claude-opus-4-6'];
  if (modelId.includes('sonnet')) return PRICING['claude-sonnet-4-6'] || PRICING['claude-sonnet-4-5-20250929'];
  if (modelId.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  return PRICING['claude-opus-4-6']; // default to most expensive
}

function getModelTier(modelId) {
  if (!modelId) return 'unknown';
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  if (modelId.includes('haiku')) return 'haiku';
  if (modelId.includes('codex')) return 'codex';
  return 'unknown';
}

/** Calculate cost for a model's usage stats */
function calculateModelCost(modelId, stats) {
  const price = getModelPrice(modelId);
  const m = 1_000_000;

  return {
    input: (stats.inputTokens / m) * price.input,
    output: (stats.outputTokens / m) * price.output,
    cacheRead: (stats.cacheReadInputTokens / m) * price.cacheRead,
    cacheWrite: (stats.cacheCreationInputTokens / m) * price.cacheWrite,
    total: 0, // calculated below
  };
}

/** Calculate total costs from stats-cache modelUsage */
function calculateTotalCosts(modelUsage) {
  const costs = {};
  let grandTotal = 0;

  for (const [modelId, stats] of Object.entries(modelUsage)) {
    const cost = calculateModelCost(modelId, stats);
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    costs[modelId] = cost;
    grandTotal += cost.total;
  }

  return { byModel: costs, grandTotal };
}

/** Calculate what the cost WOULD have been if tasks were optimally routed */
function calculateOptimalCost(modelUsage) {
  // If everything ran on the cheapest model that could handle it
  // Rough estimate: 60% of opus work could be sonnet, 30% could be haiku
  let currentTotal = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  for (const [modelId, stats] of Object.entries(modelUsage)) {
    const cost = calculateModelCost(modelId, stats);
    currentTotal += cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    totalInput += stats.inputTokens;
    totalOutput += stats.outputTokens;
    totalCacheRead += stats.cacheReadInputTokens;
    totalCacheWrite += stats.cacheCreationInputTokens;
  }

  // Optimal: 30% opus, 40% sonnet, 30% haiku
  const opusPrice = getModelPrice('claude-opus-4-6');
  const sonnetPrice = getModelPrice('claude-sonnet-4-6');
  const haikuPrice = getModelPrice('claude-haiku-4-5-20251001');
  const m = 1_000_000;

  const optimalCost =
    (totalInput * 0.3 / m * opusPrice.input) +
    (totalInput * 0.4 / m * sonnetPrice.input) +
    (totalInput * 0.3 / m * haikuPrice.input) +
    (totalOutput * 0.3 / m * opusPrice.output) +
    (totalOutput * 0.4 / m * sonnetPrice.output) +
    (totalOutput * 0.3 / m * haikuPrice.output) +
    (totalCacheRead * 0.3 / m * opusPrice.cacheRead) +
    (totalCacheRead * 0.4 / m * sonnetPrice.cacheRead) +
    (totalCacheRead * 0.3 / m * haikuPrice.cacheRead) +
    (totalCacheWrite * 0.3 / m * opusPrice.cacheWrite) +
    (totalCacheWrite * 0.4 / m * sonnetPrice.cacheWrite) +
    (totalCacheWrite * 0.3 / m * haikuPrice.cacheWrite);

  return {
    current: currentTotal,
    optimal: optimalCost,
    savings: currentTotal - optimalCost,
    savingsPercent: currentTotal > 0 ? ((currentTotal - optimalCost) / currentTotal * 100) : 0,
  };
}

/** Estimate session cost based on message count (rough) */
function estimateSessionCost(messageCount, model = 'opus') {
  // Average ~2000 input tokens + ~500 output tokens per message
  const price = getModelPrice(model);
  const m = 1_000_000;
  const inputTokens = messageCount * 2000;
  const outputTokens = messageCount * 500;
  return ((inputTokens / m) * price.input) + ((outputTokens / m) * price.output);
}

/**
 * Calculate counterfactual cost: what would it have cost if everything ran on opus?
 * @param {object} byModel — { opus: { input, output, cacheRead, cacheWrite, cost }, sonnet: ..., haiku: ... }
 *   Token counts per model tier (from readSessionTokenUsage().byModel)
 */
function calculateCounterfactual(byModel) {
  if (!byModel) return { actual: 0, counterfactual: 0, savings: 0, savingsPercent: 0 };

  const opusPrice = getModelPrice('opus');
  const m = 1_000_000;
  let actual = 0;
  let counterfactual = 0;

  for (const [tier, data] of Object.entries(byModel)) {
    actual += data.cost || 0;
    // Reprice all tokens at opus rates
    const inp = data.input || 0;
    const out = data.output || 0;
    const cr = data.cacheRead || 0;
    const cw = data.cacheWrite || 0;
    counterfactual += (inp / m * opusPrice.input) +
      (out / m * opusPrice.output) +
      (cr / m * opusPrice.cacheRead) +
      (cw / m * opusPrice.cacheWrite);
  }

  return {
    actual,
    counterfactual,
    savings: counterfactual - actual,
    savingsPercent: counterfactual > 0 ? ((counterfactual - actual) / counterfactual * 100) : 0,
  };
}

/**
 * Estimate daily actual vs counterfactual from dailyModelTokens (stats-cache).
 * Uses a blended cost-per-token since we don't have input/output split per day.
 * @param {Array} dailyModelTokens — [{ date, tokensByModel: { "claude-opus-4-6": N, ... } }]
 * @param {number} days — number of days to return
 */
function calculateDailySavings(dailyModelTokens, days = 14) {
  if (!dailyModelTokens?.length) return [];

  // Blended cost-per-token for each tier (weighted average of input+output+cache pricing)
  // Based on typical ratios: ~60% cache-read, ~30% input, ~8% output, ~2% cache-write
  function blendedRate(modelId) {
    const p = getModelPrice(modelId);
    return (p.input * 0.30 + p.output * 0.08 + p.cacheRead * 0.60 + p.cacheWrite * 0.02);
  }
  const opusBlended = blendedRate('opus');

  return dailyModelTokens.slice(-days).map(d => {
    let actual = 0;
    let counterfactual = 0;
    const m = 1_000_000;

    for (const [modelId, tokens] of Object.entries(d.tokensByModel || {})) {
      const rate = blendedRate(modelId);
      actual += (tokens / m) * rate;
      counterfactual += (tokens / m) * opusBlended;
    }

    return {
      date: d.date,
      actual: Math.round(actual * 100) / 100,
      counterfactual: Math.round(counterfactual * 100) / 100,
      savings: Math.round((counterfactual - actual) * 100) / 100,
    };
  });
}

/**
 * Build a first-class per-day cost series from stats-cache dailyModelTokens.
 * Uses real token counts (not hardcoded per-call estimates) and blended
 * input/output/cache pricing per model tier.
 *
 * Each entry: { date, cost, tokens, byModel: { opus: { tokens, cost }, ... } }
 *
 * @param {Array} dailyModelTokens — [{ date, tokensByModel: { "<modelId>": N } }]
 * @param {number} days — tail window size (default 30)
 */
function buildDailyCostSeries(dailyModelTokens, days = 30) {
  if (!Array.isArray(dailyModelTokens) || dailyModelTokens.length === 0) return [];

  // Blended cost-per-token derived from typical Claude Code usage mix:
  // ~60% cache-read, ~30% input, ~8% output, ~2% cache-write.
  function blendedRate(modelId) {
    const p = getModelPrice(modelId);
    return (p.input * 0.30 + p.output * 0.08 + p.cacheRead * 0.60 + p.cacheWrite * 0.02);
  }

  const m = 1_000_000;
  return dailyModelTokens.slice(-days).map(d => {
    let totalCost = 0;
    let totalTokens = 0;
    const byModel = {};

    for (const [modelId, tokens] of Object.entries(d.tokensByModel || {})) {
      const tier = getModelTier(modelId);
      const cost = (tokens / m) * blendedRate(modelId);
      totalCost += cost;
      totalTokens += tokens;
      if (!byModel[tier]) byModel[tier] = { tokens: 0, cost: 0 };
      byModel[tier].tokens += tokens;
      byModel[tier].cost += cost;
    }

    // Round for JSON compactness
    for (const tier of Object.keys(byModel)) {
      byModel[tier].cost = Math.round(byModel[tier].cost * 10000) / 10000;
    }

    return {
      date: d.date,
      cost: Math.round(totalCost * 10000) / 10000,
      tokens: totalTokens,
      byModel,
    };
  });
}

module.exports = {
  PRICING,
  getModelPrice,
  getModelTier,
  calculateModelCost,
  calculateTotalCosts,
  calculateOptimalCost,
  estimateSessionCost,
  calculateCounterfactual,
  calculateDailySavings,
  buildDailyCostSeries,
};
