const http = require('http');
const fs = require('fs');
const path = require('path');
const parser = require('./parser');
const calculator = require('./calculator');
const { generateInsights } = require('./insights');

const PORT = process.env.PORT || 6099;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

function buildDashboardData() {
  const stats = parser.readStatsCache();
  const history = parser.readHistory();
  const sessions = parser.readSessions();
  const globalSettings = parser.readGlobalSettings();
  const dailyLogs = parser.readDailyLogs();
  const runs = parser.readRuns();
  const benchmarkSummary = parser.readBenchmarkSummary();
  const taskLog = runs.length ? runs.map(run => ({
    timestamp: run.createdAt,
    project: run.project,
    model: run.finalModel || run.recommendation?.model || 'unknown',
    size: run.classification?.complexity === 'high' ? 'L' : run.classification?.complexity === 'low' ? 'S' : 'M',
    description: run.task,
  })) : parser.readTaskLog();
  const projects = parser.getProjects(history);

  // Routing analytics (the core feature)
  const routing = parser.analyzeRouting(taskLog);

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

  // Build daily chart data
  const dailyChart = (stats?.dailyActivity || []).map(d => ({
    date: d.date,
    messages: d.messageCount,
    sessions: d.sessionCount,
    toolCalls: d.toolCallCount,
  }));

  // Model token chart
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

  return {
    stats: {
      totalSessions: stats?.totalSessions || 0,
      totalMessages: stats?.totalMessages || 0,
      lastComputedDate: stats?.lastComputedDate || 'N/A',
      firstSessionDate: stats?.firstSessionDate || 'N/A',
      hourCounts: stats?.hourCounts || {},
      longestSession: stats?.longestSession || null,
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
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, filePath);
  const ext = path.extname(filePath);

  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Claude Token Coach: http://localhost:${PORT}`);
  });
}

module.exports = {
  buildDashboardData,
  server,
};
