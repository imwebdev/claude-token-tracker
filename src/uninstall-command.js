/**
 * Uninstaller — cleanly removes all Token Coach hooks, processes, and optionally data.
 * Safe to run multiple times. Prompts before deleting data.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const DATA_HOME = process.env.TOKEN_COACH_HOME || path.join(os.homedir(), '.token-coach');

const reset  = '\x1b[0m';
const bold   = '\x1b[1m';
const dim    = '\x1b[2m';
const green  = '\x1b[32m';
const yellow = '\x1b[33m';
const red    = '\x1b[31m';

function ok(msg)   { console.log(`  ${green}[ok]${reset} ${msg}`); }
function info(msg) { console.log(`  ${dim}${msg}${reset}`); }
function warn(msg) { console.log(`  ${yellow}[!!]${reset} ${msg}`); }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  ${question} `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function removeHooksFromSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    ok('No settings.json found -- nothing to clean');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    warn('Could not parse settings.json -- skipping hook removal');
    return;
  }

  if (!settings.hooks) {
    ok('No hooks section in settings.json');
    return;
  }

  // Backup before modifying
  const backup = SETTINGS_PATH + '.pre-uninstall-' + Date.now();
  fs.copyFileSync(SETTINGS_PATH, backup);
  info(`Backed up settings to ${path.basename(backup)}`);

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;

    // Filter out any hook group that references hook-router.js
    const filtered = groups.filter(group => {
      const hooks = group.hooks || [];
      return !hooks.some(h => h.command && h.command.includes('hook-router.js'));
    });

    const diff = groups.length - filtered.length;
    if (diff > 0) {
      removed += diff;
      if (filtered.length === 0) {
        delete settings.hooks[event];
      } else {
        settings.hooks[event] = filtered;
      }
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  ok(`Removed ${removed} hook entries from settings.json`);
}

function stopPm2() {
  try {
    execSync('which pm2', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    info('PM2 not installed -- skipping');
    return;
  }

  try {
    const list = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const proc = procs.find(p => p.name === 'claude-token-tracker');
    if (proc) {
      execSync('pm2 delete claude-token-tracker', { encoding: 'utf-8', stdio: 'pipe' });
      ok('Stopped and removed PM2 dashboard process');
    } else {
      ok('No PM2 dashboard process running');
    }
  } catch {
    info('Could not query PM2 -- skipping');
  }
}

function removeNpmLink() {
  const repoDir = path.resolve(path.join(__dirname, '..'));
  try {
    execSync('npm unlink -g claude-token-tracker 2>/dev/null', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    ok('Removed global commands (claude-tokens, token-coach)');
  } catch {
    info('Global commands were not linked -- skipping');
  }
}

async function removeData() {
  if (!fs.existsSync(DATA_HOME)) {
    ok('No data directory found');
    return;
  }

  const answer = await ask(`${yellow}Delete all Token Coach data at ${DATA_HOME}? (y/N)${reset}`);
  if (answer === 'y' || answer === 'yes') {
    fs.rmSync(DATA_HOME, { recursive: true, force: true });
    ok(`Deleted ${DATA_HOME}`);
  } else {
    info(`Kept ${DATA_HOME} -- delete manually if you want: rm -rf ${DATA_HOME}`);
  }
}

async function run(args = []) {
  const keepData = args.includes('--keep-data');
  const nukeAll = args.includes('--all');

  console.log(`\n  ${bold}Claude Token Tracker -- Uninstall${reset}\n`);

  // Step 1: Remove hooks from settings.json
  removeHooksFromSettings();

  // Step 2: Stop PM2 dashboard
  stopPm2();

  // Step 3: Remove npm link
  removeNpmLink();

  // Step 4: Data directory
  if (keepData) {
    info(`Keeping data at ${DATA_HOME} (--keep-data flag)`);
  } else if (nukeAll) {
    if (fs.existsSync(DATA_HOME)) {
      fs.rmSync(DATA_HOME, { recursive: true, force: true });
      ok(`Deleted ${DATA_HOME}`);
    }
  } else {
    await removeData();
  }

  console.log(`\n  ${bold}Uninstall complete.${reset}`);
  console.log(`  ${yellow}>>> RESTART CLAUDE CODE <<<${reset}`);
  console.log(`  ${yellow}Exit Claude Code completely and relaunch it.${reset}`);

  const repoDir = path.resolve(path.join(__dirname, '..'));
  console.log(`\n  To delete the repo itself: ${dim}rm -rf ${repoDir}${reset}`);
  console.log(`  To re-install later: ${dim}node bin/cli.js init${reset}\n`);
}

module.exports = { run };
