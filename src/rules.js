/**
 * Plugin system for custom classification rules.
 * Reads rules from ~/.token-coach/rules.json and applies them before
 * the default keyword classifier in router.js.
 *
 * Rules format:
 * {
 *   "rules": [
 *     { "match": "infra|terraform|deploy", "family": "architecture", "model": "opus", "priority": 10 },
 *     { "match": "typo|spelling", "family": "code_edit", "model": "haiku", "priority": 5 }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const dataHome = require('./data-home');

const RULES_FILENAME = 'rules.json';
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

const SAMPLE_RULES = {
  rules: [
    {
      match: 'infra|terraform|deploy|k8s|kubernetes|helm',
      family: 'architecture',
      model: 'opus',
      priority: 10,
    },
    {
      match: 'typo|spelling|grammar|punctuation',
      family: 'code_edit',
      model: 'haiku',
      priority: 5,
    },
    {
      match: 'PR review|pull request review|code review',
      family: 'review',
      model: 'sonnet',
      priority: 8,
    },
  ],
};

let _cache = null;
let _cacheAt = 0;

function getRulesPath() {
  return path.join(dataHome.getDataHome(), RULES_FILENAME);
}

/**
 * Load and cache rules from ~/.token-coach/rules.json.
 * Returns an array of rule objects sorted by priority descending.
 * Returns [] if the file does not exist or is invalid.
 */
function loadRules() {
  const now = Date.now();
  if (_cache !== null && now - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  const fp = getRulesPath();
  if (!fs.existsSync(fp)) {
    _cache = [];
    _cacheAt = now;
    return _cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    _cache = [];
    _cacheAt = now;
    return _cache;
  }

  const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];

  // Sort by priority descending (higher priority wins)
  _cache = rules
    .filter(r => r && typeof r.match === 'string' && typeof r.family === 'string')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  _cacheAt = now;
  return _cache;
}

/**
 * Apply custom rules to the given prompt text.
 * Returns { family, model, reason } if a rule matches, or null.
 */
function applyCustomRules(text) {
  if (!text) return null;
  const rules = loadRules();

  for (const rule of rules) {
    let re;
    try {
      re = new RegExp(rule.match, 'i');
    } catch {
      // Invalid regex — skip
      continue;
    }

    if (re.test(text)) {
      return {
        family: rule.family,
        model: rule.model || null,
        reason: `[custom] matched rule /${rule.match}/ (priority ${rule.priority || 0}) → ${rule.family}`,
      };
    }
  }

  return null;
}

/**
 * Create a sample rules.json at ~/.token-coach/rules.json.
 * Returns the path written.
 */
function createSampleRules() {
  dataHome.ensureDataHome();
  const fp = getRulesPath();
  fs.writeFileSync(fp, JSON.stringify(SAMPLE_RULES, null, 2) + '\n');
  // Bust cache so next call picks up the new file
  _cache = null;
  _cacheAt = 0;
  return fp;
}

/**
 * List all rules currently loaded (bypasses TTL cache for display purposes).
 */
function listRules() {
  // Force a fresh read for the CLI display
  _cache = null;
  _cacheAt = 0;
  return loadRules();
}

module.exports = {
  applyCustomRules,
  loadRules,
  listRules,
  createSampleRules,
  getRulesPath,
  SAMPLE_RULES,
};
