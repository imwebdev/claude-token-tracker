#!/usr/bin/env node

const path = require('path');
const parser = require(path.join(__dirname, '..', 'src', 'parser'));
const calculator = require(path.join(__dirname, '..', 'src', 'calculator'));
const { generateInsights } = require(path.join(__dirname, '..', 'src', 'insights'));
const { runTaskCommand } = require(path.join(__dirname, '..', 'src', 'run-command'));
const { printAudit } = require(path.join(__dirname, '..', 'src', 'audit-command'));
const { printBenchmarks } = require(path.join(__dirname, '..', 'src', 'benchmark-command'));
const { printInit } = require(path.join(__dirname, '..', 'src', 'init-command'));

const args = process.argv.slice(2);
const command = args[0] || 'summary';

if (command === 'serve' || command === 'dashboard') {
  require(path.join(__dirname, '..', 'src', 'server'));
} else if (command === 'run') {
  runTaskCommand(args.slice(1).filter(arg => !arg.startsWith('--')).join(' '), args.slice(1));
} else if (command === 'audit') {
  printAudit();
} else if (command === 'benchmark') {
  printBenchmarks();
} else if (command === 'init' || command === 'setup') {
  printInit(args.slice(1));
} else if (command === 'doctor') {
  printInit(['--doctor']);
} else if (command === 'config') {
  handleConfig(args.slice(1));
} else if (command === 'learn' || command === 'learning') {
  printLearning();
} else if (command === 'update') {
  selfUpdate();
} else if (command === 'insights') {
  printInsights();
} else if (command === 'costs') {
  printCosts();
} else {
  printSummary();
}

function printSummary() {
  const stats = parser.readStatsCache();
  if (!stats) {
    console.log('No stats-cache.json found. Run Claude Code first.');
    process.exit(1);
  }

  console.log('\n  Claude Token Tracker\n');
  console.log(`  Sessions: ${stats.totalSessions?.toLocaleString() || 0}`);
  console.log(`  Messages: ${stats.totalMessages?.toLocaleString() || 0}`);
  console.log(`  Data range: ${stats.firstSessionDate?.slice(0, 10)} → ${stats.lastComputedDate}\n`);

  if (stats.modelUsage) {
    const costs = calculator.calculateTotalCosts(stats.modelUsage);
    console.log(`  Estimated total cost: $${costs.grandTotal.toFixed(2)}\n`);

    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      const tier = calculator.getModelTier(model);
      const cost = calculator.calculateModelCost(model, usage);
      const total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
      console.log(`  ${tier.padEnd(8)} $${total.toFixed(2).padStart(8)}  (in: ${(usage.inputTokens / 1e6).toFixed(1)}M  out: ${(usage.outputTokens / 1e6).toFixed(1)}M  cache: ${(usage.cacheReadInputTokens / 1e9).toFixed(1)}B)`);
    }
  }

  console.log('\n  Run `claude-tokens insights` for actionable recommendations.\n');
}

function printInsights() {
  const stats = parser.readStatsCache();
  const history = parser.readHistory();
  const dailyLogs = parser.readDailyLogs();
  const taskLog = parser.readTaskLog();
  const runs = parser.readRuns();
  const projects = parser.getProjects(history);

  const insights = generateInsights({ stats, history, sessions: [], dailyLogs, taskLog, projects, mcpServers: {}, runs });

  const icons = { critical: '🔴', warning: '🟡', info: '🔵', success: '🟢' };

  console.log('\n  Claude Token Tracker — Insights\n');
  for (const i of insights) {
    console.log(`  ${icons[i.severity]} ${i.title}`);
    console.log(`     ${i.detail}`);
    console.log(`     → ${i.action}\n`);
  }
}

function printCosts() {
  const stats = parser.readStatsCache();
  if (!stats?.modelUsage) {
    console.log('No model usage data found.');
    process.exit(1);
  }

  const costs = calculator.calculateTotalCosts(stats.modelUsage);
  const optimal = calculator.calculateOptimalCost(stats.modelUsage);

  console.log('\n  Claude Token Tracker — Cost Breakdown\n');
  console.log(`  ${'Model'.padEnd(12)} ${'Input'.padStart(10)} ${'Output'.padStart(10)} ${'Cache Read'.padStart(12)} ${'Cache Write'.padStart(12)} ${'Total'.padStart(10)}`);
  console.log('  ' + '-'.repeat(68));

  for (const [model, cost] of Object.entries(costs.byModel)) {
    const tier = calculator.getModelTier(model);
    console.log(`  ${tier.padEnd(12)} $${cost.input.toFixed(2).padStart(8)} $${cost.output.toFixed(2).padStart(8)} $${cost.cacheRead.toFixed(2).padStart(10)} $${cost.cacheWrite.toFixed(2).padStart(10)} $${cost.total.toFixed(2).padStart(8)}`);
  }

  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'TOTAL'.padEnd(12)} ${' '.repeat(42)} $${costs.grandTotal.toFixed(2).padStart(8)}`);
  console.log();
  console.log(`  Optimal routing estimate: $${optimal.optimal.toFixed(2)}  (saves $${optimal.savings.toFixed(2)}, ${optimal.savingsPercent.toFixed(0)}%)\n`);
}

function selfUpdate() {
  const { execSync } = require('child_process');
  const repoDir = path.join(__dirname, '..');

  console.log('\n  Claude Token Tracker — Update\n');

  // Check for local changes that could conflict
  try {
    const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
    if (status) {
      console.log('  ⚠ You have local changes:');
      status.split('\n').forEach(l => console.log('    ' + l));
      console.log('  Stashing changes before update...');
      execSync('git stash', { cwd: repoDir, encoding: 'utf8' });
    }
  } catch (e) {
    console.log('  Could not check git status: ' + e.message);
    process.exit(1);
  }

  // Pull latest
  try {
    const result = execSync('git pull origin main 2>&1', { cwd: repoDir, encoding: 'utf8' }).trim();
    console.log('  ' + result.split('\n').join('\n  '));
  } catch (e) {
    console.log('  Pull failed: ' + e.message);
    console.log('  Try running manually: cd ' + repoDir + ' && git pull origin main');
    process.exit(1);
  }

  // Pop stash if we stashed
  try {
    const stashList = execSync('git stash list', { cwd: repoDir, encoding: 'utf8' }).trim();
    if (stashList) {
      execSync('git stash pop', { cwd: repoDir, encoding: 'utf8' });
      console.log('  Restored local changes.');
    }
  } catch (_) { /* no stash to pop */ }

  // Restart PM2 if running
  try {
    const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const procs = JSON.parse(pm2List);
    const tracker = procs.find(p => p.name === 'claude-token-tracker');
    if (tracker) {
      execSync('pm2 restart claude-token-tracker', { encoding: 'utf8' });
      console.log('  ✓ Restarted PM2 dashboard process.');
    }
  } catch (_) { /* PM2 not running or not installed */ }

  console.log('  ✓ Update complete.\n');
}

function handleConfig(args) {
  const config = require(path.join(__dirname, '..', 'src', 'config'));
  const key = args[0];
  const value = args[1];

  if (!key || key === '--list') {
    const cfg = config.read();
    console.log('\n  Claude Token Tracker — Config\n');
    console.log(`  Config file: ${config.configPath()}\n`);
    for (const [k, v] of Object.entries(cfg)) {
      const def = config.DEFAULTS[k];
      const isDefault = v === def;
      const label = isDefault ? ' (default)' : '';
      console.log(`  ${k}: ${JSON.stringify(v)}${label}`);
    }
    console.log('\n  Set a value: claude-tokens config <key> <value>');
    console.log('  Example: claude-tokens config routing_preference 20\n');
    console.log('  Preference guide:');
    console.log('    0-25:  Max savings — pushes work to haiku/sonnet aggressively');
    console.log('    26-50: Cost-conscious (default 35) — sonnet-heavy, opus only for architecture');
    console.log('    51-75: Balanced — opus for complex tasks');
    console.log('    76-100: Max quality — opus for anything medium+\n');
    return;
  }

  if (value === undefined) {
    const cfg = config.read();
    if (key in cfg) {
      console.log(`  ${key}: ${JSON.stringify(cfg[key])}`);
    } else {
      console.error(`  Unknown config key: ${key}`);
    }
    return;
  }

  // Generic set — try to parse as number/boolean/null
  let parsed = value;
  if (value === 'null') parsed = null;
  else if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (!isNaN(Number(value))) parsed = Number(value);

  // Validate routing_preference range
  if ((key === 'routing_preference' || key === '--preference') && typeof parsed === 'number') {
    if (parsed < 0 || parsed > 100) {
      console.error('  Error: routing_preference must be 0-100');
      process.exit(1);
    }
    const k = 'routing_preference';
    config.set(k, parsed);
    const label = parsed <= 25 ? 'max savings' : parsed <= 50 ? 'cost-conscious' : parsed <= 75 ? 'balanced' : 'max quality';
    console.log(`\n  ✓ ${k} set to ${parsed} (${label})\n`);
    return;
  }

  config.set(key, parsed);
  console.log(`\n  ✓ ${key} set to ${JSON.stringify(parsed)}\n`);
}

function printLearning() {
  const { getLearningStats } = require(path.join(__dirname, '..', 'src', 'learner'));
  const stats = getLearningStats();

  console.log('\n  Token Coach — Adaptive Learning\n');
  console.log(`  Samples: ${stats.totalSamples}  |  Families tracked: ${stats.familiesTracked}`);
  console.log(`  Generated: ${stats.generatedAt || 'N/A'}\n`);

  if (!stats.adjustments.length) {
    console.log('  Not enough data yet. Need at least 5 samples per family×model.\n');
    return;
  }

  const icons = { upgrade: '↑', downgrade: '↓', confirm: '✓', tracking: '·' };
  for (const a of stats.adjustments) {
    const pct = Math.round(a.rate * 100);
    const sug = a.adjustment?.suggestion || 'tracking';
    const icon = icons[sug] || '·';
    const detail = a.adjustment?.reason || '';
    console.log(`  ${icon} ${a.model.padEnd(7)} ${a.family.padEnd(14)} ${String(pct + '%').padStart(4)} (${a.samples} samples)  ${sug}`);
    if (detail) console.log(`    ${detail}`);
  }
  console.log('');
}
