const http = require('http');
const fs = require('fs');
const path = require('path');
const parser = require('./parser');
const calculator = require('./calculator');
const { generateInsights } = require('./insights');
const events = require('./events');
const { getLearningStats } = require('./learner');
const { calculateCounterfactual, calculateDailySavings } = require('./calculator');

const config = require('./config');
const os = require('os');
const PORT = process.env.PORT || config.read().dashboard_port || 6099;

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_ROUTER_MARKER = 'hook-router.js';
const DISABLED_HOOKS_PATH = path.join(os.homedir(), '.token-coach', 'disabled-hooks.json');

function readClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8')); } catch { return {}; }
}

function writeClaudeSettings(settings) {
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8');
}

function getHooksStatus() {
  const settings = readClaudeSettings();
  const hooks = settings.hooks || {};
  for (const hookList of Object.values(hooks)) {
    for (const entry of hookList) {
      for (const h of entry.hooks || []) {
        if (h.command && h.command.includes(HOOK_ROUTER_MARKER)) return true;
      }
    }
  }
  return false;
}

function disableHooks() {
  const settings = readClaudeSettings();
  const hooks = settings.hooks || {};
  const removed = {};

  for (const [event, hookList] of Object.entries(hooks)) {
    const kept = [];
    const stripped = [];
    for (const entry of hookList) {
      const keptHooks = [];
      const strippedHooks = [];
      for (const h of entry.hooks || []) {
        if (h.command && h.command.includes(HOOK_ROUTER_MARKER)) {
          strippedHooks.push(h);
        } else {
          keptHooks.push(h);
        }
      }
      if (strippedHooks.length) {
        stripped.push({ ...entry, hooks: strippedHooks });
        if (keptHooks.length) kept.push({ ...entry, hooks: keptHooks });
      } else {
        kept.push(entry);
      }
    }
    if (stripped.length) removed[event] = stripped;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }

  settings.hooks = hooks;
  writeClaudeSettings(settings);
  fs.writeFileSync(DISABLED_HOOKS_PATH, JSON.stringify(removed, null, 2), 'utf-8');
}

function enableHooks() {
  if (!fs.existsSync(DISABLED_HOOKS_PATH)) return;
  const removed = JSON.parse(fs.readFileSync(DISABLED_HOOKS_PATH, 'utf-8'));
  const settings = readClaudeSettings();
  const hooks = settings.hooks || {};

  for (const [event, entries] of Object.entries(removed)) {
    if (!hooks[event]) hooks[event] = [];
    hooks[event].push(...entries);
  }

  settings.hooks = hooks;
  writeClaudeSettings(settings);
  fs.unlinkSync(DISABLED_HOOKS_PATH);
}
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

/**
 * Extend cached stats with live data from history.jsonl for dates after lastComputedDate.
 * The CLI's stats-cache.json can go stale — this fills the gap so charts stay current.
 */
function extendStatsWithHistory(stats, history, dailyLogs) {
  const cutoff = stats?.lastComputedDate || '1970-01-01';
  const extended = {
    dailyActivity: [...(stats?.dailyActivity || [])],
    hourCounts: { ...(stats?.hourCounts || {}) },
    totalMessages: stats?.totalMessages || 0,
    totalSessions: stats?.totalSessions || 0,
  };

  // Bucket history entries after the cache cutoff by date and hour
  const byDate = {};
  const sessionDates = new Set();
  let newMessages = 0;

  for (const h of history) {
    if (!h.timestamp) continue;
    const d = new Date(h.timestamp);
    const dateStr = d.toISOString().slice(0, 10);
    if (dateStr <= cutoff) continue;

    newMessages++;
    const hour = String(d.getHours());
    extended.hourCounts[hour] = (extended.hourCounts[hour] || 0) + 1;

    if (!byDate[dateStr]) byDate[dateStr] = { messages: 0, sessions: new Set() };
    byDate[dateStr].messages++;
    if (h.project) byDate[dateStr].sessions.add(h.project + '|' + dateStr);
  }

  // Also pull message counts from daily usage logs for dates after cutoff
  for (const [date, count] of Object.entries(dailyLogs.interactions || {})) {
    if (date <= cutoff) continue;
    if (!byDate[date]) byDate[date] = { messages: 0, sessions: new Set() };
    // Usage logs count interactions — use as floor if history.jsonl has fewer
    if (count > byDate[date].messages) byDate[date].messages = count;
  }

  // Append new daily activity entries
  const sortedDates = Object.keys(byDate).sort();
  for (const date of sortedDates) {
    extended.dailyActivity.push({
      date,
      messageCount: byDate[date].messages,
      sessionCount: byDate[date].sessions.size || 1,
      toolCallCount: 0, // can't derive from history.jsonl
    });
  }

  extended.totalMessages += newMessages;
  extended.totalSessions += sortedDates.length; // rough estimate

  return extended;
}

function buildDashboardData() {
  const stats = parser.readStatsCache();
  const history = parser.readHistory();
  const sessions = parser.readSessions();
  const globalSettings = parser.readGlobalSettings();
  const dailyLogs = parser.readDailyLogs();
  const runs = parser.readRuns();
  const benchmarkSummary = parser.readBenchmarkSummary();
  // Merge both data sources: CSV task log + ledger runs
  const csvLog = parser.readTaskLog();
  const runsLog = runs.map(run => ({
    timestamp: run.createdAt,
    project: run.project,
    model: run.finalModel || run.recommendation?.model || 'unknown',
    size: run.classification?.complexity === 'high' ? 'L' : run.classification?.complexity === 'low' ? 'S' : 'M',
    description: run.task,
  }));
  // Combine and sort by timestamp (newest last)
  const taskLog = [...csvLog, ...runsLog].sort((a, b) =>
    (a.timestamp || '').localeCompare(b.timestamp || ''));
  const projects = parser.getProjects(history);

  // Extend cached stats with live history data to fill the gap
  const liveStats = extendStatsWithHistory(stats, history, dailyLogs);

  // Routing analytics computed after hook event merge below
  let routing;

  // MCP server info per project
  const mcpServers = {};
  for (const [name, info] of Object.entries(projects)) {
    const projectSettings = parser.readProjectSettings(info.path);
    const servers = parser.getMcpServers(globalSettings, projectSettings, info.path);
    mcpServers[name] = { ...servers, projectPath: info.path };
  }

  // Calculate costs
  const costs = stats?.modelUsage ? calculator.calculateTotalCosts(stats.modelUsage) : null;
  const optimal = stats?.modelUsage ? calculator.calculateOptimalCost(stats.modelUsage) : null;

  // Generate insights
  const insights = generateInsights({
    stats, history, sessions, dailyLogs, taskLog, projects, mcpServers, runs,
  });

  // Build daily chart data from the EXTENDED stats (includes post-cache data)
  const dailyChart = (liveStats.dailyActivity || []).map(d => ({
    date: d.date,
    messages: d.messageCount,
    sessions: d.sessionCount,
    toolCalls: d.toolCallCount,
  }));

  // Model token chart (still from cache — no token data in history.jsonl)
  const modelTokenChart = (stats?.dailyModelTokens || []).map(d => ({
    date: d.date,
    ...d.tokensByModel,
  }));

  // Model usage summary
  const modelSummary = {};
  for (const [model, usage] of Object.entries(stats?.modelUsage || {})) {
    const tier = calculator.getModelTier(model);
    const cost = calculator.calculateModelCost(model, usage);
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    modelSummary[tier] = {
      model,
      ...usage,
      cost,
    };
  }

  // Live routing events from hooks — no limit, read full history
  const routingStats = events.getRoutingStats();
  const recentEvents = events.readEvents({});

  // Merge hook routing_decision events into the taskLog so "All Time" timeline is complete
  const hookDecisions = recentEvents.filter(e => e.type === 'routing_decision');
  const existingTimestamps = new Set(taskLog.map(t => t.timestamp));
  for (const d of hookDecisions) {
    if (!d.ts || existingTimestamps.has(d.ts)) continue;
    taskLog.push({
      timestamp: d.ts,
      project: d.project || 'unknown',
      model: d.recommended_model || 'sonnet',
      baseModel: d.base_model || null,
      modelFloor: d.model_floor || null,
      size: d.classification?.complexity === 'high' ? 'L' : d.classification?.complexity === 'low' ? 'S' : 'M',
      description: d.prompt_preview || d.recommended_reason || 'task',
    });
  }
  // Also merge subagent_dispatch events as delegation entries
  const hookDispatches = recentEvents.filter(e => e.type === 'subagent_dispatch');
  for (const d of hookDispatches) {
    if (!d.ts || existingTimestamps.has(d.ts)) continue;
    const tgt = d.model_used || d.recommended_model || 'sonnet';
    const src = d.parent_model || 'opus';
    taskLog.push({
      timestamp: d.ts,
      project: d.project || 'unknown',
      model: tgt,
      baseModel: src,
      modelFloor: null,
      isSubagent: true,
      size: 'M',
      description: d.description || d.agent_type || 'subagent dispatch',
    });
  }
  taskLog.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  // Now compute routing analytics with the complete merged taskLog
  routing = parser.analyzeRouting(taskLog);

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // Compute live-only stats from routing events (hooks data only, no stale cache)
  const liveRoutingEvents = recentEvents.filter(e => e.type === 'routing_decision' || e.type === 'subagent_dispatch');
  const liveHourCounts = {};
  for (const ev of recentEvents) {
    if (!ev.ts) continue;
    const hour = String(new Date(ev.ts).getHours());
    liveHourCounts[hour] = (liveHourCounts[hour] || 0) + 1;
  }

  // Merge hook events into today stats (hooks are the source of truth for routing)
  const todayEvents = recentEvents.filter(e => e.ts && e.ts.startsWith(todayStr));
  const todayDecisions = todayEvents.filter(e => e.type === 'routing_decision');
  const todayDispatches = todayEvents.filter(e => e.type === 'subagent_dispatch');

  const hookTodayModels = { opus: 0, sonnet: 0, haiku: 0, codex: 0 };
  for (const d of todayDecisions) {
    const rec = d.recommended_model || 'sonnet';
    hookTodayModels[rec] = (hookTodayModels[rec] || 0) + 1;
  }

  // Override today stats with hook data when hook data is richer
  if (todayDecisions.length > (routing.todayStats?.totalTasks || 0)) {
    // Build task entries from hook routing_decision events
    const hookTasks = todayDecisions.map(d => ({
      timestamp: d.ts,
      project: d.project || 'unknown',
      model: d.recommended_model || 'sonnet',
      baseModel: d.base_model || null,
      modelFloor: d.model_floor || null,
      size: d.classification?.complexity === 'high' ? 'L' : d.classification?.complexity === 'low' ? 'S' : 'M',
      description: d.prompt_preview || d.recommended_reason || 'task',
    }));
    routing.todayStats = {
      ...routing.todayStats,
      date: todayStr,
      totalTasks: todayDecisions.length,
      models: hookTodayModels,
      delegations: todayDispatches.length,
      tasks: hookTasks,
    };
    routing.delegationRate = todayDecisions.length > 0
      ? (todayDispatches.length / todayDecisions.length * 100) : 0;
  }

  // Build per-day breakdown from recentEvents (already loaded, no limit)
  const dailyBreakdown = {};
  for (const ev of recentEvents) {
    if (!ev.ts) continue;
    const day = ev.ts.slice(0, 10);
    if (!dailyBreakdown[day]) dailyBreakdown[day] = { date: day, decisions: 0, dispatches: 0, models: { opus: 0, sonnet: 0, haiku: 0 }, cost: 0 };
    const d = dailyBreakdown[day];
    if (ev.type === 'routing_decision') {
      d.decisions++;
      const m = ev.recommended_model || 'sonnet';
      d.models[m] = (d.models[m] || 0) + 1;
    }
    if (ev.type === 'subagent_dispatch') d.dispatches++;
  }
  // Rough per-call cost estimates
  const MODEL_COST = { opus: 0.10, sonnet: 0.03, haiku: 0.005 };
  for (const d of Object.values(dailyBreakdown)) {
    d.cost = (d.models.opus || 0) * MODEL_COST.opus + (d.models.sonnet || 0) * MODEL_COST.sonnet + (d.models.haiku || 0) * MODEL_COST.haiku;
    d.delegationRate = d.decisions > 0 ? Math.round(d.dispatches / d.decisions * 100) : 0;
  }
  const dailyBreakdownArr = Object.values(dailyBreakdown).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);

  // Compute efficiency analysis
  function computeAnalysis(todayTokenUsage, recentEvts, routingData) {
    const bm = todayTokenUsage?.byModel || {};
    const opusCalls = bm.opus?.calls || 0;
    const sonnetCalls = bm.sonnet?.calls || 0;
    const haikuCalls = bm.haiku?.calls || 0;
    const totalCalls = opusCalls + sonnetCalls + haikuCalls;
    const cheapPct = totalCalls > 0 ? Math.round((sonnetCalls + haikuCalls) / totalCalls * 100) : 0;
    const opusPct = totalCalls > 0 ? Math.round(opusCalls / totalCalls * 100) : 0;
    const haikuPct = totalCalls > 0 ? Math.round(haikuCalls / totalCalls * 100) : 0;
    const delegationRate = routingData?.delegationRate || 0;
    const todayCost = todayTokenUsage?.totalCost || 0;
    const sessions = todayTokenUsage?.bySession || {};
    const sessionList = Object.entries(sessions);
    const longSessions = sessionList.filter(([, s]) => (s.calls || 0) > 30);

    // Determine grade
    let grade, gradeSummary;
    if (totalCalls === 0) {
      grade = null; gradeSummary = 'No activity yet today';
    } else if (cheapPct >= 70 && delegationRate >= 30) {
      grade = 'A'; gradeSummary = `${cheapPct}% of tasks on sonnet/haiku — excellent routing`;
    } else if (cheapPct >= 50) {
      grade = 'B'; gradeSummary = `${cheapPct}% on cheaper models — good, room to improve`;
    } else if (cheapPct >= 30) {
      grade = 'C'; gradeSummary = `${opusPct}% of calls on opus — routing underutilised`;
    } else {
      grade = 'D'; gradeSummary = `${opusPct}% opus — most tasks could use cheaper models`;
    }

    // Build tips
    const tips = [];
    if (opusPct > 50 && totalCalls > 0) tips.push('Most tasks are running on opus. Start sessions with the sonnet model to let routing kick in.');
    if (longSessions.length > 0) tips.push(`${longSessions.length} session${longSessions.length > 1 ? 's' : ''} exceeded 30 prompts. Use /compact or start fresh to reduce context costs.`);
    if (delegationRate < 20 && totalCalls > 5) tips.push('Delegation rate is low. Task-type hints in prompts (e.g. "search for…", "read this file") help the router pick cheaper models.');
    if (haikuPct < 5 && totalCalls > 10) tips.push('Haiku is rarely used. Simple lookups, searches, and reads are good haiku candidates.');
    if (todayCost > 3) tips.push(`High spend today ($${todayCost.toFixed(2)}). Check the Token hogs panel to find the biggest consumers.`);

    return { grade, gradeSummary, tips: tips.slice(0, 3), totalCalls, cheapPct, opusPct, delegationRate };
  }

  const analysis = computeAnalysis(parser.readSessionTokenUsage(), recentEvents, routing);

  return {
    stats: {
      totalSessions: liveStats.totalSessions,
      totalMessages: liveStats.totalMessages,
      lastComputedDate: stats?.lastComputedDate || 'N/A',
      lastLiveDate: todayStr,
      cacheStale: stats?.lastComputedDate ? stats.lastComputedDate < todayStr : true,
      firstSessionDate: todayStr, // Fresh start — show when hooks started
      hourCounts: liveHourCounts,
      longestSession: stats?.longestSession || null,
      // Separate live vs archived stats
      liveEvents: recentEvents.length,
      liveDecisions: liveRoutingEvents.length,
    },
    costs,
    optimal,
    insights,
    routing,
    benchmarkSummary,
    dailyChart: dailyChart.slice(-30),
    modelTokenChart: modelTokenChart.slice(-30),
    modelSummary,
    projects: Object.entries(projects).map(([name, info]) => ({
      name,
      messages: info.messageCount,
      lastSeen: new Date(info.lastSeen).toISOString(),
      mcpEnabled: mcpServers[name]?.enabled?.length || 0,
      mcpDisabled: mcpServers[name]?.disabled?.length || 0,
    })).sort((a, b) => b.messages - a.messages),
    taskLog: taskLog.slice(-2000).reverse(),
    hooksEnabled: getHooksStatus(),
    runs: runs.slice(0, 200),
    dailyLogs: {
      interactions: dailyLogs.interactions,
      errors: dailyLogs.errors,
    },
    // Live routing data from hooks — full history, newest first
    routingEvents: {
      stats: routingStats,
      recent: recentEvents.slice().reverse(),
    },
    // Per-session cost tracking (now using real token data from session files)
    sessionCosts: events.getSessionCosts(),
    // Real token usage from Claude Code session files
    todayTokenUsage: parser.readSessionTokenUsage(),
    // Adaptive learning stats
    learning: getLearningStats(),
    // Token hog analysis
    tokenHogs: events.getTokenHogs(),
    // Savings: actual vs counterfactual (what-if-everything-was-opus)
    savings: {
      today: calculateCounterfactual(parser.readSessionTokenUsage()?.byModel),
      daily: calculateDailySavings(stats?.dailyModelTokens, 14),
    },
    // User config (for dashboard UI controls)
    config: config.read(),
    // Per-day routing breakdown (last 30 days)
    dailyBreakdown: dailyBreakdownArr,
    // Efficiency analysis / grading
    analysis,
  };
}

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (req.url === '/api/routing') {
    try {
      const stats = events.getRoutingStats();
      const recent = events.readEvents({ limit: 500 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats, events: recent.reverse() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/config') {
    if (req.method === 'GET') {
      const cfg = config.read();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cfg));
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const updates = JSON.parse(body);
          // Only allow known config keys
          const allowed = new Set(Object.keys(config.DEFAULTS));
          for (const [k, v] of Object.entries(updates)) {
            if (!allowed.has(k)) continue;
            if (k === 'default_model' && !['haiku', 'sonnet', 'opus'].includes(v)) continue;
            config.set(k, v);
          }
          config.clearCache();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(config.read()));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  if (req.url === '/api/hooks/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: getHooksStatus() }));
    return;
  }

  if (req.url === '/api/hooks/toggle' && req.method === 'POST') {
    try {
      const enabled = getHooksStatus();
      if (enabled) disableHooks();
      else enableHooks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: !enabled }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/dashboard') {
    try {
      const data = buildDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve static files — with path containment check
  let filePath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  filePath = path.resolve(PUBLIC_DIR, '.' + filePath);

  // Prevent path traversal — resolved path must stay inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

if (require.main === module) {
  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`Claude Token Coach: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

module.exports = {
  buildDashboardData,
  server,
};
