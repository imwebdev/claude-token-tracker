#!/usr/bin/env node

const path = require('path');
const parser = require(path.join(__dirname, '..', 'src', 'parser'));
const calculator = require(path.join(__dirname, '..', 'src', 'calculator'));
const { generateInsights } = require(path.join(__dirname, '..', 'src', 'insights'));
const { runTaskCommand } = require(path.join(__dirname, '..', 'src', 'run-command'));
const { printAudit } = require(path.join(__dirname, '..', 'src', 'audit-command'));
const { printBenchmarks } = require(path.join(__dirname, '..', 'src', 'benchmark-command'));

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
