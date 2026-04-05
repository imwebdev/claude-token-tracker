/**
 * Setup wizard — configures hooks, data directories, and optionally PM2.
 * Idempotent: safe to run multiple times.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const dataHome = require('./data-home');
const config = require('./config');
const { classifyTask, recommendModel } = require('./router');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT = path.resolve(path.join(__dirname, '..', 'bin', 'hook-router.js'));

// All hook events the tracker needs
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SubagentStop',
];

const HOOK_ENTRY = {
  type: 'command',
  command: `node ${HOOK_SCRIPT}`,
  timeout: 10,
};

const dim = '\x1b[2m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';

function ok(msg) { console.log(`  ${green}✓${reset} ${msg}`); }
function warn(msg) { console.log(`  ${yellow}⚠${reset} ${msg}`); }
function fail(msg) { console.log(`  ${red}✗${reset} ${msg}`); }
function info(msg) { console.log(`  ${dim}${msg}${reset}`); }

function checkClaude() {
  try {
    execSync('which claude', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch { return {}; }
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  // Backup existing settings
  if (fs.existsSync(SETTINGS_PATH)) {
    const backup = SETTINGS_PATH + '.backup-' + Date.now();
    fs.copyFileSync(SETTINGS_PATH, backup);
    info(`Backed up existing settings to ${path.basename(backup)}`);
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function hookAlreadyInstalled(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some(group => {
    const hooks = group.hooks || [];
    return hooks.some(h => h.command && h.command.includes('hook-router.js'));
  });
}

function installHooks(settings) {
  if (!settings.hooks) settings.hooks = {};
  let installed = 0;
  let skipped = 0;

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    if (hookAlreadyInstalled(settings.hooks[event])) {
      skipped++;
      continue;
    }

    settings.hooks[event].push({
      matcher: '',
      hooks: [{ ...HOOK_ENTRY }],
    });
    installed++;
  }

  return { installed, skipped };
}

function getPort() {
  const cfg = config.read();
  return cfg.dashboard_port || 6099;
}

function setupPm2(repoDir) {
  const port = getPort();
  try {
    execSync('which pm2', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    warn('PM2 not installed — skipping dashboard auto-start');
    info('Install PM2 globally: npm install -g pm2');
    info(`Then run: PORT=${port} pm2 start src/server.js --name claude-token-tracker`);
    return false;
  }

  try {
    const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const existing = procs.find(p => p.name === 'claude-token-tracker');
    if (existing) {
      // Delete and re-create so env vars are updated
      execSync('pm2 delete claude-token-tracker', { encoding: 'utf-8', stdio: 'pipe' });
    }
  } catch {}

  try {
    execSync(`PORT=${port} pm2 start ${path.join(repoDir, 'src', 'server.js')} --name claude-token-tracker`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: repoDir,
    });
    ok(`Started dashboard via PM2 (http://localhost:${port})`);
    return true;
  } catch (e) {
    warn('Could not start PM2 process: ' + e.message);
    return false;
  }
}

function runDiagnostics() {
  console.log(`\n  ${bold}Diagnostics${reset}\n`);
  let pass = 0;
  let total = 0;

  // 1. Claude CLI
  total++;
  if (checkClaude()) {
    ok('Claude CLI found');
    pass++;
  } else {
    fail('Claude CLI not found — install from https://docs.anthropic.com/en/docs/claude-code');
  }

  // 2. Hooks installed
  total++;
  const settings = readSettings();
  const allInstalled = HOOK_EVENTS.every(e =>
    hookAlreadyInstalled(settings.hooks?.[e]));
  if (allInstalled) {
    ok(`All ${HOOK_EVENTS.length} hooks installed`);
    pass++;
  } else {
    const missing = HOOK_EVENTS.filter(e => !hookAlreadyInstalled(settings.hooks?.[e]));
    fail(`Missing hooks: ${missing.join(', ')}`);
  }

  // 3. Data directory
  total++;
  const home = dataHome.getDataHome();
  if (fs.existsSync(home)) {
    ok(`Data directory exists: ${home}`);
    pass++;
  } else {
    fail(`Data directory missing: ${home}`);
  }

  // 4. Hook script accessible
  total++;
  if (fs.existsSync(HOOK_SCRIPT)) {
    ok(`Hook script found: ${HOOK_SCRIPT}`);
    pass++;
  } else {
    fail(`Hook script missing: ${HOOK_SCRIPT}`);
  }

  // 5. Dashboard reachable
  total++;
  const port = getPort();
  try {
    const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const proc = procs.find(p => p.name === 'claude-token-tracker');
    if (proc && proc.pm2_env?.status === 'online') {
      ok(`Dashboard running via PM2 (port ${port})`);
      pass++;
    } else {
      warn(`Dashboard not running — start with: claude-tokens dashboard`);
    }
  } catch {
    warn('Dashboard not running — start with: claude-tokens dashboard');
  }

  // 6. Router test
  total++;
  const c = classifyTask('search for all TODO comments in the codebase');
  const r = recommendModel(c);
  if (c.family === 'search_read' && r.model === 'haiku') {
    ok('Router working: "search for TODOs" → haiku (correct)');
    pass++;
  } else {
    warn(`Router test: expected haiku, got ${r.model} (${c.family})`);
  }

  console.log(`\n  ${bold}${pass}/${total} checks passed${reset}\n`);
  return pass === total;
}

function parsePort(args) {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const p = parseInt(args[idx + 1], 10);
    if (p > 0 && p < 65536) return p;
  }
  return null;
}

function printInit(args = []) {
  const repoDir = path.resolve(path.join(__dirname, '..'));
  const isDiagnose = args.includes('--doctor') || args.includes('doctor');

  if (isDiagnose) {
    runDiagnostics();
    return;
  }

  console.log(`\n  ${bold}Claude Token Tracker — Setup${reset}\n`);

  // Step 0: Parse --port flag and save to config early (before PM2 needs it)
  const portArg = parsePort(args);
  if (portArg) {
    config.set('dashboard_port', portArg);
  }

  // Step 1: Check Claude CLI
  if (checkClaude()) {
    ok('Claude CLI detected');
  } else {
    warn('Claude CLI not found — hooks will be installed but won\'t fire until Claude is available');
  }

  // Step 2: Create data directories
  dataHome.ensureDataHome();
  ok(`Data directory: ${dataHome.getDataHome()}`);

  // Step 3: Write default config if none exists
  const cfg = config.read();
  if (!fs.existsSync(config.configPath())) {
    config.set('routing_preference', cfg.routing_preference);
    ok(`Config created: ${config.configPath()}`);
    info(`Routing preference: ${cfg.routing_preference}/100 (sonnet-heavy — saves money)`);
  } else {
    ok(`Config exists: ${config.configPath()}`);
    info(`Routing preference: ${cfg.routing_preference}/100`);
  }

  if (portArg) {
    ok(`Dashboard port set to ${portArg}`);
  }

  // Step 4: Install hooks
  const settings = readSettings();
  const { installed, skipped } = installHooks(settings);
  if (installed > 0) {
    writeSettings(settings);
    ok(`Installed ${installed} hooks into ${SETTINGS_PATH}`);
    if (skipped > 0) info(`${skipped} hooks were already installed`);
  } else {
    ok(`All ${HOOK_EVENTS.length} hooks already installed`);
  }

  // Step 5: PM2 dashboard
  setupPm2(repoDir);

  // Step 6: Validation
  console.log('');
  const c = classifyTask('search for all files containing TODO');
  const r = recommendModel(c);
  ok(`Router test: "search for TODOs" → ${r.model} (${c.family}/${c.complexity})`);

  const port = getPort();
  console.log(`\n  ${bold}Setup complete!${reset}`);
  console.log(`  Dashboard: ${green}http://localhost:${port}${reset}`);
  console.log(`  Config:    ${dim}${config.configPath()}${reset}`);
  console.log(`  Data:      ${dim}${dataHome.getDataHome()}${reset}`);
  console.log(`\n  ${yellow}⚠ Restart Claude Code${reset} (exit and relaunch) for hooks to take effect.`);
  console.log(`  Run ${bold}claude-tokens doctor${reset} anytime to check health.\n`);
}

module.exports = { printInit, runDiagnostics };
