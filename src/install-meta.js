/**
 * Install metadata — the "installed_at" timestamp is the anchor point for
 * "cost since install" visualizations (see #83). Written idempotently on
 * first init; never overwritten, so the date stays accurate across upgrades.
 *
 * File: ~/.token-coach/install.json
 *   { installed_at: ISO timestamp, version: semver from package.json }
 */
const fs = require('fs');
const path = require('path');
const dataHome = require('./data-home');

function installPath() {
  return dataHome.getPath('install.json');
}

function readPackageVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    return pkg.version || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Record the install timestamp if not already present.
 * Idempotent: never overwrites an existing marker.
 *
 * @returns {{ installed_at: string, version: string, created: boolean }}
 */
function recordInstall() {
  dataHome.ensureDataHome();
  const fp = installPath();
  if (fs.existsSync(fp)) {
    try {
      const existing = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (existing && existing.installed_at) {
        return { ...existing, created: false };
      }
    } catch { /* fall through and rewrite */ }
  }
  const meta = {
    installed_at: new Date().toISOString(),
    version: readPackageVersion(),
  };
  fs.writeFileSync(fp, JSON.stringify(meta, null, 2) + '\n');
  return { ...meta, created: true };
}

/** Read install metadata, or null if not yet recorded. */
function readInstall() {
  const fp = installPath();
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return null; }
}

module.exports = { recordInstall, readInstall, installPath };
