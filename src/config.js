/**
 * User configuration — stored at ~/.token-coach/config.json
 * Provides routing preferences and feature toggles.
 */
const fs = require('fs');
const dataHome = require('./data-home');

const DEFAULTS = {
  // Model floor: the starting model for all tasks.
  // 'haiku'  — start everything on haiku, only upgrade when needed
  // 'sonnet' — start on sonnet, upgrade to opus for complex work (default)
  // 'opus'   — everything runs on opus, no routing
  model_floor: 'sonnet',

  // Legacy — kept for backward compat; ignored when model_floor is set explicitly.
  routing_preference: 35,

  // Daily budget alerts (USD). null = disabled.
  daily_alert: null,
  daily_cap: null,

  // Dashboard port. null = use default 6099.
  dashboard_port: null,
};

let _cache = null;

function configPath() {
  return dataHome.getConfigPath();
}

/** Map legacy routing_preference to model_floor. */
function migratePreference(user) {
  // If user already set model_floor explicitly, skip migration
  if (user.model_floor) return user;
  // If they have a routing_preference, derive model_floor from it
  if (user.routing_preference != null) {
    const pref = user.routing_preference;
    if (pref <= 25) user.model_floor = 'haiku';
    else if (pref <= 75) user.model_floor = 'sonnet';
    else user.model_floor = 'opus';
  }
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
  _cache = { ...DEFAULTS, ...migratePreference(user) };
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
