/**
 * Report command — generates a weekly digest of token usage, routing, costs, and recommendations.
 *
 * Usage:
 *   node bin/cli.js report              — print formatted text to stdout
 *   node bin/cli.js report --markdown   — print as markdown (Slack/docs friendly)
 *   node bin/cli.js report --save       — save to ~/.token-coach/reports/YYYY-MM-DD.md
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readEvents, getRoutingStats, estimatePromptCost } = require('./events');
const { calculateTotalCosts, calculateOptimalCost, getModelTier } = require('./calculator');
const { generateInsights } = require('./insights');
const { getLearningStats } = require('./learner');
const parser = require('./parser');

const DATA_DIR = process.env.TOKEN_COACH_HOME || path.join(os.homedir(), '.token-coach');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

/** Return YYYY-MM-DD for N days ago */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Return "Month DD, YYYY" */
function fmtDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Format a dollar amount */
function fmtCost(n) {
  return `$${n.toFixed(4)}`;
}

/** Format a percentage */
function fmtPct(n) {
  return `${Math.round(n)}%`;
}

/**
 * Collect all data needed for the report.
 */
function collectData() {
  const since = daysAgo(7);
  const today = new Date().toISOString().slice(0, 10);

  // Events-based routing stats for the last 7 days
  const routingStats = getRoutingStats({ since });

  // Raw events for cost estimation
  const weekEvents = readEvents({ since });
  const decisions = weekEvents.filter(e => e.type === 'routing_decision');
  const dispatches = weekEvents.filter(e => e.type === 'subagent_dispatch');

  // Count prompts by model from routing decisions
  const promptsByModel = { haiku: 0, sonnet: 0, opus: 0 };
  let estimatedCost = 0;

  for (const ev of decisions) {
    const model = ev.recommended_model || 'opus';
    const tier = model.includes('haiku') ? 'haiku' : model.includes('sonnet') ? 'sonnet' : 'opus';
    promptsByModel[tier] = (promptsByModel[tier] || 0) + 1;
    estimatedCost += estimatePromptCost(model);
  }

  for (const ev of dispatches) {
    const model = ev.model_used || 'sonnet';
    estimatedCost += estimatePromptCost(model);
  }

  const totalPrompts = decisions.length;
  const totalDelegations = dispatches.length;

  // Cost breakdown by model tier (from routing decisions)
  const costByTier = { haiku: 0, sonnet: 0, opus: 0 };
  for (const ev of decisions) {
    const model = ev.recommended_model || 'opus';
    const tier = model.includes('haiku') ? 'haiku' : model.includes('sonnet') ? 'sonnet' : 'opus';
    costByTier[tier] += estimatePromptCost(model);
  }

  // Task log for the last 7 days
  const allTaskLog = parser.readTaskLog();
  const weekTaskLog = allTaskLog.filter(t => t.timestamp && t.timestamp.slice(0, 10) >= since);

  // Stats cache for historical cost data (optional)
  const statsCache = parser.readStatsCache();
  const history = parser.readHistory();
  const dailyLogs = parser.readDailyLogs();
  const runs = parser.readRuns();
  const projects = parser.getProjects(history);

  // Insights for this period
  const insights = generateInsights({
    stats: statsCache,
    history,
    sessions: [],
    dailyLogs,
    taskLog: weekTaskLog,
    projects,
    mcpServers: {},
    runs,
  });

  // Filter warning/critical only
  const wasteInsights = insights
    .filter(i => i.severity === 'warning' || i.severity === 'critical')
    .slice(0, 3);

  // Learning stats
  const learningStats = getLearningStats();

  // Delegation rate from task log
  const taskLogDelegations = weekTaskLog.filter(t => t.model && t.model.includes('>')).length;
  const taskLogDelegationRate = weekTaskLog.length > 0
    ? (taskLogDelegations / weekTaskLog.length * 100) : 0;

  // Combine delegation rate: prefer event-based if available, fall back to task log
  const effectiveDelegationRate = totalPrompts > 0
    ? routingStats.delegationRate
    : taskLogDelegationRate;

  // Optimal dispatch %: dispatches that matched recommendation
  const optimalDispatchPct = totalDelegations > 0
    ? Math.round((routingStats.optimal / totalDelegations) * 100) : 0;

  // Top recommendations: top 3 actionable from all insights
  const recommendations = insights
    .filter(i => i.action && i.action.length > 0)
    .filter(i => i.severity !== 'success')
    .slice(0, 3);

  return {
    since,
    today,
    totalPrompts,
    promptsByModel,
    totalDelegations,
    estimatedCost,
    costByTier,
    wasteInsights,
    learningStats,
    effectiveDelegationRate,
    optimalDispatchPct,
    recommendations,
    weekTaskLog,
  };
}

/**
 * Render the report as lines of text.
 * If markdown=true, uses markdown headers/formatting.
 */
function renderReport(data, markdown) {
  const {
    since, today, totalPrompts, promptsByModel, totalDelegations,
    estimatedCost, costByTier, wasteInsights, learningStats,
    effectiveDelegationRate, optimalDispatchPct, recommendations,
    weekTaskLog,
  } = data;

  const lines = [];

  const h1 = markdown ? s => `# ${s}` : s => `  ${s}`;
  const h2 = markdown ? s => `## ${s}` : s => `  ─── ${s} ───`;
  const h3 = markdown ? s => `### ${s}` : s => `  ${s}`;
  const li = markdown ? s => `- ${s}` : s => `  • ${s}`;
  const rule = markdown ? () => '---' : () => '  ' + '─'.repeat(56);
  const blank = () => '';

  // ── Header ──────────────────────────────────────────
  lines.push(h1('Token Coach — Weekly Report'));
  lines.push(blank());
  lines.push(markdown
    ? `**Period:** ${fmtDate(since)} → ${fmtDate(today)}`
    : `  Period: ${fmtDate(since)} → ${fmtDate(today)}`
  );
  lines.push(blank());
  lines.push(rule());
  lines.push(blank());

  // ── Summary Stats ───────────────────────────────────
  lines.push(h2('Summary'));
  lines.push(blank());

  const totalP = totalPrompts || weekTaskLog.length;
  const haikuCount = promptsByModel.haiku;
  const sonnetCount = promptsByModel.sonnet;
  const opusCount = promptsByModel.opus;
  const haikuPct = totalP > 0 ? fmtPct(haikuCount / totalP * 100) : '0%';
  const sonnetPct = totalP > 0 ? fmtPct(sonnetCount / totalP * 100) : '0%';
  const opusPct = totalP > 0 ? fmtPct(opusCount / totalP * 100) : '0%';

  if (markdown) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total prompts tracked | ${totalP} |`);
    lines.push(`| Haiku | ${haikuCount} (${haikuPct}) |`);
    lines.push(`| Sonnet | ${sonnetCount} (${sonnetPct}) |`);
    lines.push(`| Opus | ${opusCount} (${opusPct}) |`);
    lines.push(`| Estimated cost (events) | ${fmtCost(estimatedCost)} |`);
    lines.push(`| Delegations (subagent dispatches) | ${totalDelegations} |`);
    lines.push(`| Task log entries (week) | ${weekTaskLog.length} |`);
  } else {
    lines.push(`  Total prompts tracked : ${totalP}`);
    lines.push(`  Model distribution   :`);
    lines.push(`    Haiku   ${String(haikuCount).padStart(4)}  (${haikuPct})`);
    lines.push(`    Sonnet  ${String(sonnetCount).padStart(4)}  (${sonnetPct})`);
    lines.push(`    Opus    ${String(opusCount).padStart(4)}  (${opusPct})`);
    lines.push(`  Estimated cost       : ${fmtCost(estimatedCost)}`);
    lines.push(`  Delegations          : ${totalDelegations}`);
    lines.push(`  Task log entries     : ${weekTaskLog.length}`);
  }
  lines.push(blank());

  // ── Cost Breakdown ───────────────────────────────────
  lines.push(h2('Cost Breakdown by Model Tier'));
  lines.push(blank());

  const totalCost = costByTier.haiku + costByTier.sonnet + costByTier.opus;

  if (markdown) {
    lines.push(`| Tier | Estimated Cost | Share |`);
    lines.push(`|------|---------------|-------|`);
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const c = costByTier[tier];
      const pct = totalCost > 0 ? fmtPct(c / totalCost * 100) : '0%';
      lines.push(`| ${tier} | ${fmtCost(c)} | ${pct} |`);
    }
    lines.push(`| **Total** | **${fmtCost(totalCost)}** | 100% |`);
  } else {
    lines.push(`  ${'Tier'.padEnd(10)} ${'Estimated Cost'.padStart(16)} ${'Share'.padStart(8)}`);
    lines.push('  ' + '─'.repeat(38));
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const c = costByTier[tier];
      const pct = totalCost > 0 ? fmtPct(c / totalCost * 100) : '0%';
      lines.push(`  ${tier.padEnd(10)} ${fmtCost(c).padStart(16)} ${pct.padStart(8)}`);
    }
    lines.push('  ' + '─'.repeat(38));
    lines.push(`  ${'TOTAL'.padEnd(10)} ${fmtCost(totalCost).padStart(16)}`);
  }
  lines.push(blank());

  // ── Top 3 Waste Patterns ─────────────────────────────
  lines.push(h2('Top Waste Patterns'));
  lines.push(blank());

  if (wasteInsights.length === 0) {
    lines.push(li('No warning or critical waste patterns detected this week.'));
  } else {
    const icons = { critical: '[CRITICAL]', warning: '[WARNING]' };
    for (let i = 0; i < wasteInsights.length; i++) {
      const w = wasteInsights[i];
      const tag = markdown ? `**${icons[w.severity] || '[INFO]'}**` : (icons[w.severity] || '[INFO]');
      if (markdown) {
        lines.push(`**${i + 1}. ${w.title}** ${tag}`);
        lines.push(blank());
        lines.push(w.detail);
        lines.push(blank());
        lines.push(`> Action: ${w.action}`);
      } else {
        lines.push(`  ${i + 1}. ${tag} ${w.title}`);
        lines.push(`     ${w.detail}`);
        lines.push(`     → ${w.action}`);
      }
      lines.push(blank());
    }
  }

  // ── Learning Progress ────────────────────────────────
  lines.push(h2('Learning Progress'));
  lines.push(blank());

  const adjustmentCount = learningStats.adjustments.filter(a => a.adjustment !== null).length;

  if (markdown) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Families tracked | ${learningStats.familiesTracked} |`);
    lines.push(`| Total samples | ${learningStats.totalSamples} |`);
    lines.push(`| Active adjustments | ${adjustmentCount} |`);
    lines.push(`| Last updated | ${learningStats.generatedAt ? learningStats.generatedAt.slice(0, 16) : 'N/A'} |`);
  } else {
    lines.push(`  Families tracked   : ${learningStats.familiesTracked}`);
    lines.push(`  Total samples      : ${learningStats.totalSamples}`);
    lines.push(`  Active adjustments : ${adjustmentCount}`);
    lines.push(`  Last updated       : ${learningStats.generatedAt ? learningStats.generatedAt.slice(0, 16) : 'N/A'}`);
  }

  if (learningStats.adjustments.length > 0) {
    lines.push(blank());
    lines.push(markdown ? '**Notable adjustments:**' : '  Notable adjustments:');
    for (const a of learningStats.adjustments.slice(0, 3)) {
      if (!a.adjustment) continue;
      const pct = Math.round(a.rate * 100);
      const detail = `${a.model}/${a.family} — ${a.adjustment.suggestion} (${pct}%, ${a.samples} samples)`;
      lines.push(li(detail));
    }
  }
  lines.push(blank());

  // ── Routing Accuracy ─────────────────────────────────
  lines.push(h2('Routing Accuracy'));
  lines.push(blank());

  if (markdown) {
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Delegation rate | ${fmtPct(effectiveDelegationRate)} |`);
    lines.push(`| Optimal dispatch rate | ${fmtPct(optimalDispatchPct)} |`);
    lines.push(`| Total dispatches | ${totalDelegations} |`);
  } else {
    lines.push(`  Delegation rate      : ${fmtPct(effectiveDelegationRate)}`);
    lines.push(`  Optimal dispatch     : ${fmtPct(optimalDispatchPct)}`);
    lines.push(`  Total dispatches     : ${totalDelegations}`);
  }
  lines.push(blank());

  // ── Recommendations ──────────────────────────────────
  lines.push(h2('Recommendations'));
  lines.push(blank());

  if (recommendations.length === 0) {
    lines.push(li('Nothing critical to address — keep monitoring weekly.'));
  } else {
    for (let i = 0; i < recommendations.length; i++) {
      const r = recommendations[i];
      if (markdown) {
        lines.push(`**${i + 1}. ${r.title}**`);
        lines.push(blank());
        lines.push(r.action);
      } else {
        lines.push(`  ${i + 1}. ${r.title}`);
        lines.push(`     → ${r.action}`);
      }
      lines.push(blank());
    }
  }

  lines.push(rule());
  lines.push(markdown
    ? `*Generated by Token Coach on ${today}*`
    : `  Generated by Token Coach on ${today}`
  );
  lines.push(blank());

  return lines.join('\n');
}

/**
 * Main entry point — called by bin/cli.js as printReport(args).
 */
function printReport(args = []) {
  const isMarkdown = args.includes('--markdown');
  const isSave = args.includes('--save');

  const data = collectData();
  const report = renderReport(data, isMarkdown || isSave);

  if (isSave) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = path.join(REPORTS_DIR, `${data.today}.md`);
    fs.writeFileSync(filename, report, 'utf-8');
    console.log(`\n  Report saved to: ${filename}\n`);
  } else {
    console.log(report);
  }
}

module.exports = { printReport };
