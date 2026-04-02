const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_HOME_NAME = '.token-coach';

function getDataHome() {
  return process.env.TOKEN_COACH_HOME || path.join(os.homedir(), DATA_HOME_NAME);
}

function normalizeProjectSlug(projectPath) {
  if (!projectPath) return 'unknown';

  return String(projectPath)
    .trim()
    .toLowerCase()
    .replace(/^[.\\/]+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-') || 'unknown';
}

function getPath(...segments) {
  return path.join(getDataHome(), ...segments);
}

function getConfigPath() {
  return getPath('config.json');
}

function getRunsPath(...segments) {
  return getPath('runs', ...segments);
}

function getRunsDir(...segments) {
  return getRunsPath(...segments);
}

function getEventsPath(...segments) {
  return getPath('events', ...segments);
}

function getEventsDir(...segments) {
  return getEventsPath(...segments);
}

function getBenchmarksPath(...segments) {
  return getPath('benchmarks', ...segments);
}

function getBenchmarksDir(...segments) {
  return getBenchmarksPath(...segments);
}

function getReportsPath(...segments) {
  return getPath('reports', ...segments);
}

function getReportsDir(...segments) {
  return getReportsPath(...segments);
}

function getProjectsPath(...segments) {
  return getPath('projects', ...segments);
}

function getProjectsDir(...segments) {
  return getProjectsPath(...segments);
}

function getCachePath(...segments) {
  return getPath('cache', ...segments);
}

function getCacheDir(...segments) {
  return getCachePath(...segments);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureDataHome() {
  ensureDir(getDataHome());
  ensureDir(getRunsPath());
  ensureDir(getEventsPath());
  ensureDir(getBenchmarksPath());
  ensureDir(getReportsPath());
  ensureDir(getProjectsPath());
  ensureDir(getCachePath());
  return getDataHome();
}

module.exports = {
  DATA_HOME_NAME,
  getDataHome,
  normalizeProjectSlug,
  getPath,
  getConfigPath,
  getRunsPath,
  getRunsDir,
  getEventsPath,
  getEventsDir,
  getBenchmarksPath,
  getBenchmarksDir,
  getReportsPath,
  getReportsDir,
  getProjectsPath,
  getProjectsDir,
  getCachePath,
  getCacheDir,
  ensureDir,
  ensureDataHome,
};
