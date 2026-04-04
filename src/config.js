/**
 * User configuration — stored at ~/.token-coach/config.json
 * Provides routing preferences and feature toggles.
 */
const fs = require('fs');
const dataHome = require('./data-home');

const DEFAULTS = {
  // Routing preference: 0 = cheapest possible, 50 = balanced, 100 = max quality
  // Default 35 = sonnet-heavy (protects users from token burn)
  routing_preference: 35,

  // Daily budget alerts (USD). null = disabled.
  daily_alert: null,
  daily_cap: null,
};

let _cache = null;

function configPath() {
  return dataHome.getConfigPath();
}

/** Read config, merging user values over defaults. */
function read() {
  if (_cache) return _cache;
  const fp = configPath();
  let user = {};
  if (fs.existsSync(fp)) {
    try { user = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  _cache = { ...DEFAULTS, ...user };
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
