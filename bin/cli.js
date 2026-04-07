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
  // Allow --port flag to override: node bin/cli.js dashboard --port 8080
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1] && !process.env.PORT) {
    process.env.PORT = args[portIdx + 1];
  }
  require(path.join(__dirname, '..', 'src', 'server'));
} else if (command === 'run') {
  runTaskCommand(args.slice(1).filter(arg => !arg.startsWith('--')).join(' '), args.slice(1));
} else if (command === 'audit') {
  printAudit();
} else if (command === 'benchmark') {
  printBenchmarks();
} else if (command === 'init' || command === 'setup') {
  printInit(args.slice(1));
} else if (command === 'uninstall' || command === 'remove') {
  require(path.join(__dirname, '..', 'src', 'uninstall-command')).run(args.slice(1));
} else if (command === 'doctor') {
  printInit(['--doctor']);
} else if (command === 'config') {
  handleConfig(args.slice(1));
} else if (command === 'learn' || command === 'learning') {
  printLearning();
} else if (command === 'experiment' || command === 'exp') {
  handleExperiment(args.slice(1));
} else if (command === 'update') {
  selfUpdate();
} else if (command === 'repl') {
  require(path.join(__dirname, '..', 'src', 'repl-command')).startRepl();
} else if (command === 'insights') {
  printInsights();
} else if (command === 'costs') {
  printCosts();
} else if (command === 'report') {
  require(path.join(__dirname, '..', 'src', 'report-command')).printReport(args.slice(1));
} else if (command === 'rules') {
  printRules();
} else if (command === 'models') {
  handleModels(args.slice(1));
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
    console.log('  Example: claude-tokens config default_model haiku\n');
    console.log('  Default model (routing starts here, adjusts up or down by task complexity):');
    console.log('    haiku  — Start on haiku, upgrade for complex tasks (max savings)');
    console.log('    sonnet — Start on sonnet (default), haiku for simple, opus for complex');
    console.log('    opus   — Always use opus, no downgrading\n');
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

  // Validate dashboard_port range
  if (key === 'dashboard_port' && typeof parsed === 'number') {
    if (parsed < 1 || parsed > 65535) {
      console.error('  Error: dashboard_port must be 1-65535');
      process.exit(1);
    }
    config.set(key, parsed);
    console.log(`\n  ✓ ${key} set to ${parsed}`);
    console.log(`  Restart the dashboard for this to take effect.\n`);
    return;
  }

  // Validate default_model (also accept model_floor as legacy alias)
  if (key === 'default_model' || key === 'model_floor') {
    const valid = ['haiku', 'sonnet', 'opus'];
    if (!valid.includes(value)) {
      console.error(`  Error: default_model must be one of: ${valid.join(', ')}`);
      process.exit(1);
    }
    config.set('default_model', value);
    const labels = {
      haiku: 'haiku-first — routing starts here, upgrades for complex tasks (max savings)',
      sonnet: 'sonnet-first — routing starts here, adjusts up or down (default)',
      opus: 'opus-first — always opus, no downgrading',
    };
    console.log(`\n  ✓ default_model set to ${value} — ${labels[value]}\n`);
    return;
  }

  // Legacy: routing_preference — map to default_model
  if ((key === 'routing_preference' || key === '--preference') && typeof parsed === 'number') {
    if (parsed < 0 || parsed > 100) {
      console.error('  Error: routing_preference must be 0-100');
      process.exit(1);
    }
    config.set('routing_preference', parsed);
    const floor = parsed <= 25 ? 'haiku' : parsed <= 75 ? 'sonnet' : 'opus';
    config.set('default_model', floor);
    const label = parsed <= 25 ? 'max savings' : parsed <= 50 ? 'cost-conscious' : parsed <= 75 ? 'balanced' : 'max quality';
    console.log(`\n  ✓ routing_preference set to ${parsed} (${label})`);
    console.log(`  ✓ default_model set to ${floor}\n`);
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

function printRules() {
  const { listRules, createSampleRules, getRulesPath } = require(path.join(__dirname, '..', 'src', 'rules'));
  const rulesPath = getRulesPath();
  const rules = listRules();

  console.log('\n  Claude Token Tracker — Custom Classification Rules\n');
  console.log(`  Rules file: ${rulesPath}\n`);

  if (!rules.length) {
    console.log('  No custom rules found.');
    console.log('  Creating a sample rules.json...\n');
    const fp = createSampleRules();
    const fresh = listRules();
    console.log(`  Created: ${fp}\n`);
    if (fresh.length) {
      printRuleTable(fresh);
    }
    console.log('  Edit the file to add your own rules. Format:');
    console.log('    match   — regex pattern (case-insensitive)');
    console.log('    family  — task family (search_read, code_edit, review, plan, architecture, debug, command)');
    console.log('    model   — haiku | sonnet | opus');
    console.log('    priority — higher number wins when multiple rules match\n');
    return;
  }

  printRuleTable(rules);
  console.log(`  Total: ${rules.length} rule(s)`);
  console.log('\n  Edit rules at: ' + rulesPath + '\n');
}

function printRuleTable(rules) {
  const header = `  ${'Priority'.padEnd(10)} ${'Model'.padEnd(8)} ${'Family'.padEnd(16)} Match`;
  console.log(header);
  console.log('  ' + '-'.repeat(60));
  for (const r of rules) {
    const pri = String(r.priority || 0).padEnd(10);
    const model = (r.model || 'inherit').padEnd(8);
    const family = (r.family || '').padEnd(16);
    console.log(`  ${pri} ${model} ${family} ${r.match}`);
  }
  console.log('');
}

function handleModels(args) {
  const { listModels, writeSampleConfig, modelsPath } = require(path.join(__dirname, '..', 'src', 'models'));

  if (args[0] === 'init' || args[0] === 'create') {
    const created = writeSampleConfig();
    if (created) {
      console.log(`\n  ✓ Created sample models config at ${modelsPath()}`);
      console.log('  Edit it to define custom model capabilities.\n');
    } else {
      console.log(`\n  Models config already exists at ${modelsPath()}\n`);
    }
    return;
  }

  const { models, hasUserConfig, configPath } = listModels();
  const families = ['search_read', 'question', 'code_edit', 'command', 'review', 'plan', 'debug', 'multi_file', 'architecture'];

  console.log('\n  Token Coach — Model Capabilities\n');
  console.log(`  Config: ${hasUserConfig ? configPath : 'using built-in defaults'}`);
  if (!hasUserConfig) {
    console.log('  Run `claude-tokens models init` to create a customizable models.json\n');
  } else {
    console.log('  Smart selection active — router picks cheapest model meeting capability threshold\n');
  }

  const nameW = 12;
  const costW = 6;
  const capW = 5;
  let header = '  ' + 'Model'.padEnd(nameW) + 'Cost'.padStart(costW);
  for (const f of families) header += f.slice(0, 4).padStart(capW);
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const [name, profile] of Object.entries(models)) {
    let row = '  ' + name.padEnd(nameW) + (profile.cost + 'x').padStart(costW);
    for (const f of families) {
      const score = profile.capabilities[f] ?? 0;
      row += (Math.round(score * 100) + '').padStart(capW);
    }
    console.log(row);
  }
  console.log('');
}

function handleExperiment(args) {
  const experiments = require(path.join(__dirname, '..', 'src', 'experiments'));
  const sub = args[0];

  if (sub === 'create') {
    let family, models, count = 50, split = 50;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--family' && args[i + 1]) family = args[++i];
      else if (args[i] === '--models' && args[i + 1]) models = args[++i].split(',').map(m => m.trim());
      else if (args[i] === '--count' && args[i + 1]) count = parseInt(args[++i], 10);
      else if (args[i] === '--split' && args[i + 1]) split = parseInt(args[++i], 10);
    }

    if (!family) {
      console.error('\n  Error: --family is required');
      console.error('  Example: claude-tokens exp create --family code_edit --models haiku,sonnet --count 30\n');
      process.exit(1);
    }
    if (!models || models.length < 2) {
      console.error('\n  Error: --models must list at least 2 models (e.g. haiku,sonnet)\n');
      process.exit(1);
    }

    const exp = experiments.createExperiment(family, models, count, split);
    console.log('\n  Experiment created\n');
    console.log(`  ID:       ${exp.id}`);
    console.log(`  Family:   ${exp.family}`);
    console.log(`  Models:   ${exp.models.join(' vs ')}`);
    console.log(`  Split:    ${exp.split}% / ${100 - exp.split}%`);
    console.log(`  Target:   ${exp.target} assignments`);
    console.log(`  Status:   ${exp.status}\n`);
    return;
  }

  if (sub === 'stop') {
    let family;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--family' && args[i + 1]) family = args[++i];
    }
    if (!family) {
      const report = experiments.getExperimentReport();
      if (report.active.length === 0) { console.log('\n  No active experiments to stop.\n'); return; }
      family = report.active[0].family;
    }
    const stopped = experiments.stopExperiment(family);
    if (!stopped) { console.log(`\n  No active experiment for family: ${family}\n`); return; }
    console.log(`\n  Experiment ${stopped.id} stopped.`);
    if (stopped.winner) console.log(`  Winner: ${stopped.winner} (by success rate)`);
    console.log('');
    return;
  }

  // Default: show report
  const report = experiments.getExperimentReport();

  console.log('\n  Claude Token Tracker — A/B Routing Experiments\n');

  if (report.active.length === 0 && report.completed.length === 0) {
    console.log('  No experiments yet.');
    console.log('  Create one: claude-tokens exp create --family code_edit --models haiku,sonnet --count 30\n');
    return;
  }

  if (report.active.length > 0) {
    console.log('  Active\n');
    for (const exp of report.active) {
      console.log(`  ${exp.id}  ${exp.family}  ${exp.progress}`);
      console.log(`    Models: ${exp.models.join(' vs ')}  |  Split: ${exp.split}/${100 - exp.split}`);
      for (const s of exp.modelStats) {
        const pct = s.rate != null ? `${s.rate}% success` : 'no data';
        console.log(`      ${s.model.padEnd(8)} ${s.total} assignments  ${pct}`);
      }
      console.log('');
    }
  }

  if (report.completed.length > 0) {
    console.log('  Completed / Stopped\n');
    for (const exp of report.completed) {
      const winnerLabel = exp.winner ? `  winner: ${exp.winner}` : '';
      console.log(`  ${exp.id}  ${exp.family}  ${exp.status}  ${exp.progress}${winnerLabel}`);
      for (const s of exp.modelStats) {
        const pct = s.rate != null ? `${s.rate}% success` : 'no data';
        console.log(`      ${s.model.padEnd(8)} ${s.total} assignments  ${pct}`);
      }
      console.log('');
    }
  }

  console.log('  Commands:');
  console.log('    claude-tokens exp create --family <family> --models <m1,m2> --count <n>');
  console.log('    claude-tokens exp stop [--family <family>]\n');
}
