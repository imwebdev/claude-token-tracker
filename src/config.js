/**
 * User configuration — stored at ~/.token-coach/config.json
 * Provides routing preferences and feature toggles.
 */
const fs = require('fs');
const dataHome = require('./data-home');

const DEFAULTS = {
  // Default model: where routing starts. Tasks go up or down from here based on complexity.
  // 'haiku'  — start on haiku, upgrade for complex tasks (max savings)
  // 'sonnet' — start on sonnet, haiku for simple tasks, opus for complex (default)
  // 'opus'   — everything runs on opus, no downgrading
  default_model: 'sonnet',

  // Legacy — kept for backward compat; ignored when default_model is set explicitly.
  routing_preference: 35,

  // Daily budget alerts (USD). null = disabled.
  daily_alert: null,
  daily_cap: null,

  // Dashboard port. null = use default 6099.
  dashboard_port: null,

  // How many days of event history to keep. Older JSONL files are pruned on dashboard load.
  history_days: 14,
};

let _cache = null;

function configPath() {
  return dataHome.getConfigPath();
}

/** Migrate legacy keys to current schema. */
function migrate(user) {
  // model_floor → default_model (renamed for clarity)
  if (!user.default_model && user.model_floor) {
    user.default_model = user.model_floor;
  }
  // routing_preference → default_model (oldest compat)
  if (!user.default_model && user.routing_preference != null) {
    const pref = user.routing_preference;
    if (pref <= 25) user.default_model = 'haiku';
    else if (pref <= 75) user.default_model = 'sonnet';
    else user.default_model = 'opus';
  }
  // Strip legacy keys so they don't appear in the runtime config
  delete user.model_floor;
  return user;
}

/** Read config, merging user values over defaults. */
function read() {
  if (_cache) return _cache;
  const fp = configPath();
  let user = {};
  if (fs.existsSync(fp)) {
    try { user = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  _cache = { ...DEFAULTS, ...migrate(user) };
  return _cache;
}

/** Write a config value. */
function set(key, value) {
  const fp = configPath();
  dataHome.ensureDataHome();
  let existing = {};
  if (fs.existsSync(fp)) {
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  existing[key] = value;
  fs.writeFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
  _cache = null; // bust cache
  return existing;
}

/** Clear the in-memory cache (useful after writes). */
function clearCache() {
  _cache = null;
}

module.exports = { DEFAULTS, read, set, clearCache, configPath };
