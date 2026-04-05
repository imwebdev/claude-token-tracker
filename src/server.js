const http = require('http');
const fs = require('fs');
const path = require('path');
const parser = require('./parser');
const calculator = require('./calculator');
const { generateInsights } = require('./insights');
const events = require('./events');
const { getLearningStats } = require('./learner');

const config = require('./config');
const PORT = process.env.PORT || config.read().dashboard_port || 6099;
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
    const servers = parser.getMcpServers(globalSettings, projectSettings);
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

  // Live routing events from hooks
  const routingStats = events.getRoutingStats();
  const recentEvents = events.readEvents({ limit: 500 });

  // Merge hook routing_decision events into the taskLog so "All Time" timeline is complete
  const hookDecisions = recentEvents.filter(e => e.type === 'routing_decision');
  const existingTimestamps = new Set(taskLog.map(t => t.timestamp));
  for (const d of hookDecisions) {
    if (!d.ts || existingTimestamps.has(d.ts)) continue;
    taskLog.push({
      timestamp: d.ts,
      project: d.project || 'unknown',
      model: d.recommended_model || 'sonnet',
      size: d.classification?.complexity === 'high' ? 'L' : d.classification?.complexity === 'low' ? 'S' : 'M',
      description: d.prompt_preview || d.recommended_reason || 'task',
    });
  }
  // Also merge subagent_dispatch events as delegation entries (opus>sonnet etc)
  const hookDispatches = recentEvents.filter(e => e.type === 'subagent_dispatch');
  for (const d of hookDispatches) {
    if (!d.ts || existingTimestamps.has(d.ts)) continue;
    const src = d.parent_model || 'opus';
    const tgt = d.model_used || d.recommended_model || 'sonnet';
    taskLog.push({
      timestamp: d.ts,
      project: d.project || 'unknown',
      model: src + '>' + tgt,
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
    taskLog: taskLog.slice(-200).reverse(),
    runs: runs.slice(0, 200),
    dailyLogs: {
      interactions: dailyLogs.interactions,
      errors: dailyLogs.errors,
    },
    // Live routing data from hooks
    routingEvents: {
      stats: routingStats,
      recent: recentEvents.slice(-100).reverse(),
    },
    // Per-session cost tracking
    sessionCosts: events.getSessionCosts(),
    // Adaptive learning stats
    learning: getLearningStats(),
    // Token hog analysis
    tokenHogs: events.getTokenHogs(),
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
