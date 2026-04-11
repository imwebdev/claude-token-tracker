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

// Use the absolute path to the current node binary so hooks work even when
// node is managed by nvm/fnm/volta (which aren't loaded in non-interactive shells).
const NODE_EXE = process.execPath;

const HOOK_ENTRY = {
  type: 'command',
  command: `${NODE_EXE} ${HOOK_SCRIPT}`,
  timeout: 10,
};

const dim = '\x1b[2m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';

function ok(msg) { console.log(`  ${green}[ok]${reset} ${msg}`); }
function warn(msg) { console.log(`  ${yellow}[!!]${reset} ${msg}`); }
function fail(msg) { console.log(`  ${red}[FAIL]${reset} ${msg}`); }
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
  let updated = 0;

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    if (hookAlreadyInstalled(settings.hooks[event])) {
      // Update existing hook command to use current node path and script location
      let didUpdate = false;
      for (const group of settings.hooks[event]) {
        for (const h of (group.hooks || [])) {
          if (h.command && h.command.includes('hook-router.js') && h.command !== HOOK_ENTRY.command) {
            h.command = HOOK_ENTRY.command;
            didUpdate = true;
          }
        }
      }
      if (didUpdate) {
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    settings.hooks[event].push({
      matcher: '',
      hooks: [{ ...HOOK_ENTRY }],
    });
    installed++;
  }

  return { installed, skipped, updated };
}

function getPort() {
  const cfg = config.read();
  return cfg.dashboard_port || 6099;
}

/**
 * Try to register the dashboard as a systemd user service.
 * No sudo required — user services auto-start on login.
 * Returns true if successful.
 */
function setupSystemdService(repoDir, port) {
  // Only attempt on Linux with systemd user session available
  try {
    execSync('systemctl --user status 2>/dev/null', { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) {
    // Exit code non-zero but stderr might contain actual failure vs "no units running"
    if (e.status === 1) {
      // Status 1 means systemd is available but no units are active — that's fine
    } else {
      return false; // systemd not available
    }
  }

  try {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(serviceDir, { recursive: true });
    const servicePath = path.join(serviceDir, 'claude-token-tracker.service');
    const serverScript = path.join(repoDir, 'src', 'server.js');
    const serviceContent = [
      '[Unit]',
      'Description=Claude Token Tracker Dashboard',
      'After=network.target',
      '',
      '[Service]',
      `ExecStart=${process.execPath} ${serverScript}`,
      `Environment=PORT=${port}`,
      'Environment=HOST=0.0.0.0',
      'Restart=on-failure',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    fs.writeFileSync(servicePath, serviceContent);
    execSync('systemctl --user daemon-reload', { encoding: 'utf-8', stdio: 'pipe' });
    execSync('systemctl --user enable --now claude-token-tracker', { encoding: 'utf-8', stdio: 'pipe' });
    ok(`Dashboard registered as systemd user service (auto-starts on login, no sudo needed)`);
    ok(`Service file: ${servicePath}`);
    return true;
  } catch (e) {
    warn('Could not set up systemd user service: ' + e.message);
    return false;
  }
}

function setupPm2(repoDir) {
  const port = getPort();
  try {
    execSync('which pm2', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    warn('PM2 not installed -- trying systemd user service instead');
    if (setupSystemdService(repoDir, port)) return true;
    info('To install PM2: npm install -g pm2');
    info(`Then run: PORT=${port} HOST=0.0.0.0 pm2 start src/server.js --name claude-token-tracker`);
    return false;
  }

  try {
    const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const existing = procs.find(p => p.name === 'claude-token-tracker');
    if (existing) {
      // Delete and re-create so env vars (HOST, PORT) are updated
      execSync('pm2 delete claude-token-tracker', { encoding: 'utf-8', stdio: 'pipe' });
    }
  } catch {}

  try {
    execSync(
      `PORT=${port} HOST=0.0.0.0 pm2 start ${path.join(repoDir, 'src', 'server.js')} --name claude-token-tracker`,
      { encoding: 'utf-8', stdio: 'pipe', cwd: repoDir }
    );
    ok(`Dashboard started (http://0.0.0.0:${port} -- accessible on network)`);
  } catch (e) {
    warn('Could not start PM2 process: ' + e.message);
    return false;
  }

  // Persist so PM2 resurrects after reboot
  try {
    execSync('pm2 save', { encoding: 'utf-8', stdio: 'pipe' });
    ok('PM2 process list saved (survives PM2 restarts)');
  } catch {
    warn('pm2 save failed -- process list not persisted');
  }

  // Register PM2 with the OS init system so it starts on every reboot
  // pm2 startup exits with code 1 and writes to stderr — capture both streams
  let startupOutput = '';
  try {
    startupOutput = execSync('pm2 startup', { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) {
    startupOutput = (e.stdout || '') + (e.stderr || '');
  }
  const sudoLine = startupOutput.split('\n').find(l => /^\s*sudo\s+/.test(l));
  if (sudoLine) {
    try {
      execSync(sudoLine.trim(), { encoding: 'utf-8', stdio: 'pipe' });
      ok('PM2 registered with system startup (auto-starts on reboot)');
    } catch {
      // sudo needs a password — fall back to systemd user service (no sudo required)
      warn('PM2 system startup requires sudo (skipped). Trying systemd user service...');
      if (!setupSystemdService(repoDir, port)) {
        warn('Run this once to make PM2 start on reboot (requires sudo):');
        info(sudoLine.trim());
      }
    }
  } else {
    // pm2 startup didn't emit a sudo command — try systemd user service as reliable fallback
    if (!setupSystemdService(repoDir, port)) {
      ok('PM2 startup already configured or not needed');
    }
  }

  return true;
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
    fail('Claude CLI not found -- install from https://docs.anthropic.com/en/docs/claude-code');
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
  let dashboardRunning = false;
  // Check via HTTP first (works regardless of PM2 or systemd)
  try {
    execSync(`curl -sf --max-time 3 http://localhost:${port}/api/dashboard > /dev/null 2>&1`, {
      encoding: 'utf-8', stdio: 'pipe',
    });
    ok(`Dashboard reachable at http://localhost:${port}`);
    dashboardRunning = true;
    pass++;
  } catch {
    // HTTP check failed — check PM2 for more specific error
    let pm2Status = null;
    try {
      const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
      const procs = JSON.parse(list);
      const proc = procs.find(p => p.name === 'claude-token-tracker');
      pm2Status = proc?.pm2_env?.status;
    } catch {}
    // Check systemd user service
    let systemdStatus = null;
    try {
      systemdStatus = execSync('systemctl --user is-active claude-token-tracker 2>/dev/null', {
        encoding: 'utf-8', stdio: 'pipe',
      }).trim();
    } catch {}
    if (pm2Status === 'online' || systemdStatus === 'active') {
      warn(`Dashboard process running but not responding on port ${port} -- check logs`);
    } else {
      warn(`Dashboard not running on port ${port} -- run: node bin/cli.js init`);
      info('Or start manually: node src/server.js');
    }
  }

  // 6. Router test
  total++;
  const c = classifyTask('search for all TODO comments in the codebase');
  const r = recommendModel(c);
  if (c.family === 'search_read' && r.model === 'haiku') {
    ok('Router working: "search for TODOs" -> haiku (correct)');
    pass++;
  } else {
    warn(`Router test: expected haiku, got ${r.model} (${c.family})`);
  }

  // 7. End-to-end hook test
  total++;
  const repoDir = path.resolve(path.join(__dirname, '..'));
  const hookScript = path.resolve(path.join(repoDir, 'bin', 'hook-router.js'));
  const testInput = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'search for all files matching the pattern in this repo',
    cwd: repoDir,
    session_id: 'doctor-test',
  });
  try {
    // Use `input` option instead of shell echo pipe — cross-platform safe (avoids cmd.exe on Windows)
    const result = execSync(
      `node "${hookScript}"`,
      { encoding: 'utf-8', input: testInput, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    );
    const parsed = JSON.parse(result);
    if (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) {
      ok('Hook fires correctly (end-to-end verified)');
      pass++;
    } else {
      fail('Hook returned unexpected output');
      info('Output: ' + result.slice(0, 200));
    }
  } catch (e) {
    fail('Hook does NOT work -- Claude Code will not show routing advice');
    if (e.stderr) info('Error: ' + e.stderr.toString().trim().slice(0, 200));
    else info('Error: ' + e.message.slice(0, 200));
  }

  // 8. Check for recent hook errors
  total++;
  const errLog = path.join(dataHome.getDataHome(), 'hook-errors.log');
  if (fs.existsSync(errLog)) {
    const content = fs.readFileSync(errLog, 'utf-8').trim();
    const lines = content.split('\n');
    const recent = lines.slice(-5).join('\n');
    if (content.length > 0) {
      warn(`Hook error log has entries (${lines.length} lines)`);
      info('Recent errors:');
      recent.split('\n').forEach(l => info('  ' + l));
    } else {
      ok('No hook errors logged');
      pass++;
    }
  } else {
    ok('No hook errors logged');
    pass++;
  }

  // 9. Verify settings.json hook path matches this repo
  total++;
  const hookCmd = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command || '';
  // Normalize paths for comparison: strip quotes, normalize separators (Windows compat)
  const hookCmdNorm = hookCmd.replace(/"/g, '').replace(/\\/g, '/');
  const hookScriptNorm = hookScript.replace(/\\/g, '/');
  if (hookCmdNorm.includes(hookScriptNorm)) {
    ok('Hook path in settings.json matches this repo');
    pass++;
  } else if (hookCmd.includes('hook-router.js')) {
    fail('Hook path in settings.json points to WRONG location');
    info('Expected: ' + NODE_EXE + ' ' + hookScript);
    info('Found:    ' + hookCmd);
    info('Fix: re-run "node bin/cli.js init" from this directory');
  } else {
    fail('No hook-router.js found in settings.json');
    info('Fix: run "node bin/cli.js init"');
  }

  // 10. Check for bare 'node' in hook command (nvm/fnm/volta issue)
  total++;
  if (hookCmd.startsWith('node ') && !hookCmd.startsWith('/')) {
    fail('Hook uses bare "node" -- will fail if node is managed by nvm/fnm/volta');
    info('Found: ' + hookCmd);
    info('Fix: re-run "node bin/cli.js init" to use the absolute node path');
  } else {
    ok('Hook uses absolute node path');
    pass++;
  }

  console.log(`\n  ${bold}${pass}/${total} checks passed${reset}\n`);
  return pass === total;
}

function verifyHookWorks(repoDir) {
  const hookScript = path.resolve(path.join(repoDir, 'bin', 'hook-router.js'));
  const testInput = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'search for all files matching the pattern in this repo',
    cwd: repoDir,
    session_id: 'init-test',
  });

  try {
    // Use `input` option instead of shell echo pipe — cross-platform safe (avoids cmd.exe on Windows)
    const result = execSync(
      `node "${hookScript}"`,
      { encoding: 'utf-8', input: testInput, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    );

    // Should return JSON with hookSpecificOutput containing additionalContext
    const parsed = JSON.parse(result);
    if (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) {
      ok('Hook verification passed -- fired hook and got valid routing output');
    } else {
      warn('Hook returned unexpected output -- may not work correctly');
      info('Output: ' + result.slice(0, 200));
    }
  } catch (e) {
    fail('Hook verification FAILED -- the hook will not work');
    if (e.stderr) {
      info('Error: ' + e.stderr.toString().trim().slice(0, 200));
    } else {
      info('Error: ' + e.message.slice(0, 200));
    }
    // Check for common issues
    if (!fs.existsSync(hookScript)) {
      info('Hook script not found at: ' + hookScript);
    }
    try {
      execSync('node --version', { encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      info('Node.js may not be in PATH');
    }
    // Check if settings.json has the right path
    const settings = readSettings();
    const hookCmd = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command || '';
    if (hookCmd && !hookCmd.includes(hookScript)) {
      fail('settings.json hook path does not match repo location!');
      info('Expected: ' + NODE_EXE + ' ' + hookScript);
      info('Found:    ' + hookCmd);
      info('Re-run init from the correct directory.');
    }
  }
}

function parsePort(args) {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const p = parseInt(args[idx + 1], 10);
    if (p > 0 && p < 65536) return p;
  }
  return null;
}

/**
 * Return a stable on-disk path for the package.
 * - Git clone  → the clone directory (has a .git folder)
 * - Global npm → the global node_modules entry  (stable)
 * - npx cache  → install globally then return global path
 */
function resolveStableRepoDir() {
  const selfDir = path.resolve(path.join(__dirname, '..'));
  // Already a git clone — path is stable
  if (fs.existsSync(path.join(selfDir, '.git'))) return selfDir;
  // Running from a global install (not an npx temp cache)
  if (!selfDir.includes('_npx')) return selfDir;
  // Running from npx temp cache — install globally so hooks survive cache cleans
  info('Running via npx — installing globally for persistent hooks...');
  try {
    execSync('npm install -g claude-token-tracker', { encoding: 'utf-8', stdio: 'inherit' });
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const globalDir = path.join(globalRoot, 'claude-token-tracker');
    if (fs.existsSync(globalDir)) {
      ok(`Installed to ${globalDir}`);
      return globalDir;
    }
  } catch (e) {
    warn('Global install failed — hooks may break if npm cache is cleared. Run: npm install -g claude-token-tracker');
  }
  return selfDir; // best-effort fallback
}

function printInit(args = []) {
  const repoDir = resolveStableRepoDir();
  const isDiagnose = args.includes('--doctor') || args.includes('doctor');

  if (isDiagnose) {
    runDiagnostics();
    return;
  }

  console.log(`\n  ${bold}Claude Token Tracker -- Setup${reset}\n`);

  // Step 0: Parse --port flag and save to config early (before PM2 needs it)
  const portArg = parsePort(args);
  if (portArg) {
    config.set('dashboard_port', portArg);
  }

  // Step 1: Check Claude CLI
  if (checkClaude()) {
    ok('Claude CLI detected');
  } else {
    warn('Claude CLI not found -- hooks will be installed but won\'t fire until Claude is available');
  }

  // Step 2: Create data directories
  dataHome.ensureDataHome();
  ok(`Data directory: ${dataHome.getDataHome()}`);

  // Step 3: Write default config if none exists
  const cfg = config.read();
  if (!fs.existsSync(config.configPath())) {
    config.set('routing_preference', cfg.routing_preference);
    ok(`Config created: ${config.configPath()}`);
    info(`Routing preference: ${cfg.routing_preference}/100 (sonnet-heavy -- saves money)`);
  } else {
    ok(`Config exists: ${config.configPath()}`);
    info(`Routing preference: ${cfg.routing_preference}/100`);
  }

  if (portArg) {
    ok(`Dashboard port set to ${portArg}`);
  }

  // Step 4: Install hooks
  const settings = readSettings();
  const { installed, skipped, updated } = installHooks(settings);
  if (installed > 0 || updated > 0) {
    writeSettings(settings);
    if (installed > 0) ok(`Installed ${installed} hooks into ${SETTINGS_PATH}`);
    if (updated > 0) ok(`Updated ${updated} hooks with current node path`);
    if (skipped > 0) info(`${skipped} hooks were already up-to-date`);
  } else {
    ok(`All ${HOOK_EVENTS.length} hooks already installed`);
  }

  // Step 5: PM2 dashboard
  setupPm2(repoDir);

  // Step 6: Ensure global CLI commands are available
  const isGitClone = fs.existsSync(path.join(repoDir, '.git'));
  if (isGitClone) {
    // Git clone: npm link wires up the bin entries from the local package
    try {
      execSync('npm link 2>/dev/null', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' });
      ok('Global commands installed: claude-tokens, token-coach, claude-token-tracker');
    } catch {
      info('Could not run npm link -- use: node bin/cli.js <command>');
    }
  } else {
    // npm/npx install: bin entries are wired by npm automatically
    ok('Global commands available: claude-tokens, token-coach, claude-token-tracker');
  }

  // Step 7: Validate router
  console.log('');
  const c = classifyTask('search for all files containing TODO');
  const r = recommendModel(c);
  ok(`Router test: "search for TODOs" -> ${r.model} (${c.family}/${c.complexity})`);

  // Step 8: End-to-end hook verification — actually fire the hook and check output
  verifyHookWorks(repoDir);

  const port = getPort();
  console.log(`\n  ${bold}Setup complete!${reset}`);
  console.log(`  Dashboard: ${green}http://localhost:${port}${reset}`);
  console.log(`  Config:    ${dim}${config.configPath()}${reset}`);
  console.log(`  Data:      ${dim}${dataHome.getDataHome()}${reset}`);
  console.log('');
  console.log(`  ${bold}${yellow}>>> RESTART CLAUDE CODE <<<${reset}`);
  console.log(`  ${yellow}Exit Claude Code completely and relaunch it.${reset}`);
  console.log(`  ${yellow}Hooks do not take effect until you restart.${reset}`);
  console.log('');
  const isGitCloneCheck = fs.existsSync(path.join(repoDir, '.git'));
  const doctorCmd = isGitCloneCheck ? 'node bin/cli.js doctor' : 'claude-tokens doctor';
  console.log(`  Run ${bold}${doctorCmd}${reset} anytime to check health.\n`);
}

module.exports = { printInit, runDiagnostics };
