/**
 * User-defined model capabilities and smart selection.
 *
 * Users can define custom model profiles in ~/.token-coach/models.json.
 * Each model has capability scores (0-1) per task family and a cost weight.
 * The router uses these to pick the cheapest model that exceeds a capability threshold.
 *
 * If no models.json exists, falls back to built-in defaults.
 */
const fs = require('fs');
const dataHome = require('./data-home');

const BUILTIN_MODELS = {
  haiku: {
    capabilities: {
      search_read: 0.90,
      question: 0.85,
      code_edit: 0.50,
      command: 0.60,
      review: 0.40,
      plan: 0.35,
      debug: 0.30,
      multi_file: 0.15,
      architecture: 0.10,
    },
    cost: 1.0, // relative cost (haiku = 1x baseline)
  },
  sonnet: {
    capabilities: {
      search_read: 0.80,
      question: 0.80,
      code_edit: 0.90,
      command: 0.85,
      review: 0.80,
      plan: 0.75,
      debug: 0.70,
      multi_file: 0.55,
      architecture: 0.45,
    },
    cost: 3.0,
  },
  opus: {
    capabilities: {
      search_read: 0.75,
      question: 0.85,
      code_edit: 0.95,
      command: 0.90,
      review: 0.95,
      plan: 0.95,
      debug: 0.95,
      multi_file: 0.95,
      architecture: 0.98,
    },
    cost: 15.0,
  },
};

// Minimum capability score to consider a model for a task
const DEFAULT_THRESHOLD = 0.65;

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

function modelsPath() {
  return dataHome.getPath('models.json');
}

/** Read user-defined models, merged over built-in defaults. */
function readModels() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  let userModels = {};
  const fp = modelsPath();
  if (fs.existsSync(fp)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      userModels = data.models || data || {};
    } catch {}
  }

  // Merge: user models override built-in, but built-in keys remain as fallback
  const merged = { ...BUILTIN_MODELS };
  for (const [name, profile] of Object.entries(userModels)) {
    if (merged[name]) {
      // Merge capabilities over existing
      merged[name] = {
        capabilities: { ...merged[name].capabilities, ...(profile.capabilities || {}) },
        cost: profile.cost ?? merged[name].cost,
      };
    } else {
      // New model entirely
      merged[name] = {
        capabilities: profile.capabilities || {},
        cost: profile.cost ?? 1.0,
      };
    }
  }

  _cache = merged;
  _cacheTime = now;
  return merged;
}

/**
 * Select the cheapest model that meets the capability threshold for a task family.
 * Returns { model, reason, score } or null if no user config exists.
 *
 * @param {string} family — task family (search_read, code_edit, etc.)
 * @param {string} complexity — low/medium/high (adjusts threshold)
 */
function selectByCapability(family, complexity) {
  // Only use smart selection if user has defined models.json
  if (!fs.existsSync(modelsPath())) return null;

  const models = readModels();
  const threshold = complexity === 'high' ? 0.80
    : complexity === 'low' ? 0.50
    : DEFAULT_THRESHOLD;

  // Find all models that meet the threshold for this family
  const candidates = [];
  for (const [name, profile] of Object.entries(models)) {
    const score = profile.capabilities[family] ?? 0;
    if (score >= threshold) {
      candidates.push({ name, score, cost: profile.cost });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by cost (cheapest first), break ties by score (highest first)
  candidates.sort((a, b) => a.cost - b.cost || b.score - a.score);

  const best = candidates[0];
  return {
    model: best.name,
    reason: `[smart-select] ${best.name} scores ${(best.score * 100).toFixed(0)}% for ${family} at ${best.cost}x cost (threshold: ${(threshold * 100).toFixed(0)}%)`,
    score: best.score,
  };
}

/** List all models and their capabilities (for CLI display). */
function listModels() {
  const models = readModels();
  const hasUserConfig = fs.existsSync(modelsPath());
  return {
    models,
    hasUserConfig,
    configPath: modelsPath(),
  };
}

/** Write a sample models.json for the user to customize. */
function writeSampleConfig() {
  const fp = modelsPath();
  if (fs.existsSync(fp)) return false;

  dataHome.ensureDataHome();
  const sample = {
    models: {
      haiku: BUILTIN_MODELS.haiku,
      sonnet: BUILTIN_MODELS.sonnet,
      opus: BUILTIN_MODELS.opus,
    },
  };
  fs.writeFileSync(fp, JSON.stringify(sample, null, 2) + '\n');
  return true;
}

function clearCache() { _cache = null; _cacheTime = 0; }

module.exports = {
  BUILTIN_MODELS,
  readModels,
  selectByCapability,
  listModels,
  writeSampleConfig,
  modelsPath,
  clearCache,
};
