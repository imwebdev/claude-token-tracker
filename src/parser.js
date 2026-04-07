const fs = require('fs');
const path = require('path');
const os = require('os');
const dataHome = require('./data-home');
const storage = require('./storage');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/** Read and parse stats-cache.json */
function readStatsCache() {
  const fp = path.join(CLAUDE_DIR, 'stats-cache.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

/** Read history.jsonl — each line is a JSON object */
function readHistory() {
  const fp = path.join(CLAUDE_DIR, 'history.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

/** Read all session metadata files */
function readSessions() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; }
    })
    .filter(Boolean);
}

/** Read global settings.json */
function readGlobalSettings() {
  const fp = path.join(CLAUDE_DIR, 'settings.json');
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return {}; }
}

/** Read project-level settings for a given project path */
function readProjectSettings(projectPath) {
  const slug = projectPath.replace(/\//g, '-').replace(/^-/, '');
  const fp = path.join(CLAUDE_DIR, 'projects', slug, 'settings.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

/** Read daily usage logs */
function readDailyLogs() {
  const dir = path.join(CLAUDE_DIR, 'usage');
  if (!fs.existsSync(dir)) return { interactions: {}, errors: {} };

  const interactions = {};
  const errors = {};

  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.log') && !f.includes('error')) {
      const date = f.replace('.log', '');
      const lines = fs.readFileSync(path.join(dir, f), 'utf-8').trim().split('\n').filter(Boolean);
      interactions[date] = lines.length;
    }
    if (f.includes('-errors.log')) {
      const date = f.replace('-errors.log', '');
      const lines = fs.readFileSync(path.join(dir, f), 'utf-8').trim().split('\n').filter(Boolean);
      errors[date] = lines.length;
    }
  }

  return { interactions, errors };
}

/** Read the task log CSV */
function readTaskLog() {
  const paths = [
    dataHome.getPath('task-log.csv'),
    dataHome.getPath('usage', 'task-log.csv'),
    path.join(os.homedir(), 'claude-usage', 'task-log.csv'),
    path.join(CLAUDE_DIR, 'usage', 'task-log.csv'),
    path.join(__dirname, '..', 'task-log.csv'),
  ];

  for (const fp of paths) {
    if (fs.existsSync(fp)) {
      return fs.readFileSync(fp, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^([^,]+),([^,]+),([^,]+),([^,]+),(.+)$/);
          if (!match || match[1] === 'timestamp') return null;
          return {
            timestamp: match[1],
            project: match[2],
            model: match[3],
            size: match[4],
            description: match[5],
          };
        })
        .filter(Boolean);
    }
  }
  return [];
}

function readRuns() {
  return storage.listFilesRecursive(dataHome.getRunsDir(), '.json')
    .map(fp => storage.readJson(fp))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readBenchmarkSummary() {
  return storage.readJson(dataHome.getBenchmarksDir('task-types.json'), { generatedAt: null, byFamily: [] });
}

/** Get all unique project paths from history */
function getProjects(history) {
  const projects = {};
  for (const h of history) {
    if (!h.project) continue;
    const name = path.basename(h.project);
    if (!projects[name]) {
      projects[name] = { path: h.project, messageCount: 0, firstSeen: h.timestamp, lastSeen: h.timestamp };
    }
    projects[name].messageCount++;
    projects[name].lastSeen = Math.max(projects[name].lastSeen, h.timestamp);
  }
  return projects;
}

/** Detect enabled MCP servers from settings */
function getMcpServers(globalSettings, projectSettings, projectPath) {
  const servers = new Set();
  const disabled = new Set();

  if (projectSettings?.disabledMcpServers) {
    projectSettings.disabledMcpServers.forEach(s => disabled.add(s));
  }

  // Read from ~/.claude/config.json (legacy location)
  const configPath = path.join(CLAUDE_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.mcpServers) {
        Object.keys(config.mcpServers).forEach(s => {
          if (!disabled.has(s)) servers.add(s);
        });
      }
    } catch {}
  }

  // Read from ~/.mcp.json (global MCP config, newer format)
  const globalMcpPath = path.join(os.homedir(), '.mcp.json');
  if (fs.existsSync(globalMcpPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(globalMcpPath, 'utf-8'));
      const mcpServers = mcpConfig.mcpServers || mcpConfig;
      if (typeof mcpServers === 'object') {
        Object.keys(mcpServers).forEach(s => {
          if (!disabled.has(s)) servers.add(s);
        });
      }
    } catch {}
  }

  // Read from <project>/.mcp.json (per-project MCP config)
  if (projectPath) {
    const projectMcpPath = path.join(projectPath, '.mcp.json');
    if (fs.existsSync(projectMcpPath)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(projectMcpPath, 'utf-8'));
        const mcpServers = mcpConfig.mcpServers || mcpConfig;
        if (typeof mcpServers === 'object') {
          Object.keys(mcpServers).forEach(s => {
            if (!disabled.has(s)) servers.add(s);
          });
        }
      } catch {}
    }
  }

  return { enabled: [...servers], disabled: [...disabled] };
}

/**
 * Analyze model routing patterns from the task log.
 * Parses entries like "opus", "opus>sonnet", "opus>haiku", "sonnet", "haiku", "opus>codex"
 */
function analyzeRouting(taskLog) {
  const routing = {
    totalTasks: taskLog.length,
    directRuns: { opus: 0, sonnet: 0, haiku: 0, codex: 0 },
    delegations: {},  // e.g. "opus>sonnet": 5
    delegationRate: 0,
    byDate: {},       // date -> { opus: N, sonnet: N, ... delegations: N }
    byProject: {},    // project -> { opus: N, sonnet: N, ... }
    timeline: [],     // enriched task entries with parsed routing
    todayStats: null,
  };

  // Use local date to match task log timestamps (logged with local `date` command)
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const todayTasks = [];

  for (const t of taskLog) {
    const date = t.timestamp.slice(0, 10);
    const model = t.model;

    // Parse routing: "opus>sonnet" means opus delegated to sonnet
    const isDelegation = model.includes('>');
    let sourceModel = model;
    let targetModel = null;

    if (isDelegation) {
      const parts = model.split('>');
      sourceModel = parts[0];
      targetModel = parts[1];
      routing.delegations[model] = (routing.delegations[model] || 0) + 1;
    } else {
      const tier = model.includes('opus') ? 'opus'
        : model.includes('sonnet') ? 'sonnet'
        : model.includes('haiku') ? 'haiku'
        : model.includes('codex') ? 'codex' : model;
      routing.directRuns[tier] = (routing.directRuns[tier] || 0) + 1;
    }

    // By date
    if (!routing.byDate[date]) {
      routing.byDate[date] = { opus: 0, sonnet: 0, haiku: 0, codex: 0, delegations: 0, total: 0 };
    }
    const dd = routing.byDate[date];
    dd.total++;
    if (isDelegation) {
      dd.delegations++;
      const tt = targetModel.includes('opus') ? 'opus'
        : targetModel.includes('sonnet') ? 'sonnet'
        : targetModel.includes('haiku') ? 'haiku'
        : targetModel.includes('codex') ? 'codex' : targetModel;
      dd[tt] = (dd[tt] || 0) + 1;
    } else {
      const tier = sourceModel.includes('opus') ? 'opus'
        : sourceModel.includes('sonnet') ? 'sonnet'
        : sourceModel.includes('haiku') ? 'haiku'
        : sourceModel.includes('codex') ? 'codex' : sourceModel;
      dd[tier] = (dd[tier] || 0) + 1;
    }

    // By project
    if (!routing.byProject[t.project]) {
      routing.byProject[t.project] = { opus: 0, sonnet: 0, haiku: 0, codex: 0, delegations: 0, total: 0 };
    }
    const pp = routing.byProject[t.project];
    pp.total++;
    if (isDelegation) {
      pp.delegations++;
      const tt = targetModel.includes('opus') ? 'opus'
        : targetModel.includes('sonnet') ? 'sonnet'
        : targetModel.includes('haiku') ? 'haiku'
        : targetModel.includes('codex') ? 'codex' : targetModel;
      pp[tt] = (pp[tt] || 0) + 1;
    } else {
      const tier = sourceModel.includes('opus') ? 'opus'
        : sourceModel.includes('sonnet') ? 'sonnet'
        : sourceModel.includes('haiku') ? 'haiku'
        : sourceModel.includes('codex') ? 'codex' : sourceModel;
      pp[tier] = (pp[tier] || 0) + 1;
    }

    // Timeline entry
    routing.timeline.push({
      ...t,
      isDelegation,
      sourceModel: isDelegation ? sourceModel : model,
      targetModel,
      date,
    });

    if (date === today) todayTasks.push(t);
  }

  // Delegation rate
  const totalDelegations = Object.values(routing.delegations).reduce((a, b) => a + b, 0);
  routing.delegationRate = routing.totalTasks > 0 ? (totalDelegations / routing.totalTasks * 100) : 0;

  // Today's stats
  const todaySizes = { S: 0, M: 0, L: 0 };
  const todayModels = { opus: 0, sonnet: 0, haiku: 0, codex: 0 };
  let todayDelegations = 0;
  for (const t of todayTasks) {
    todaySizes[t.size] = (todaySizes[t.size] || 0) + 1;
    if (t.model.includes('>')) {
      todayDelegations++;
      const target = t.model.split('>')[1];
      const tier = target.includes('opus') ? 'opus'
        : target.includes('sonnet') ? 'sonnet'
        : target.includes('haiku') ? 'haiku'
        : target.includes('codex') ? 'codex' : target;
      todayModels[tier] = (todayModels[tier] || 0) + 1;
    } else {
      const tier = t.model.includes('opus') ? 'opus'
        : t.model.includes('sonnet') ? 'sonnet'
        : t.model.includes('haiku') ? 'haiku'
        : t.model.includes('codex') ? 'codex' : t.model;
      todayModels[tier] = (todayModels[tier] || 0) + 1;
    }
  }

  routing.todayStats = {
    date: today,
    totalTasks: todayTasks.length,
    sizes: todaySizes,
    models: todayModels,
    delegations: todayDelegations,
    tasks: todayTasks.reverse(),
  };

  return routing;
}

/**
 * Read actual token usage from Claude Code session JSONL files.
 * Parses assistant messages with usage data, filtered by date.
 * Returns { byModel: { [model]: { input, output, cacheRead, cacheWrite } }, bySession: { [sid]: ... } }
 */
function readSessionTokenUsage(dateStr) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return { byModel: {}, bySession: {}, totalCost: 0 };

  const now = new Date();
  const targetDate = dateStr || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const byModel = {};
  const bySession = {};
  let totalCost = 0;
  let latestTimestamp = '';
  let latestSessionId = null;

  // Pricing per million tokens
  const pricing = {
    opus:   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    sonnet: { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    haiku:  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 },
  };

  function getTier(model) {
    if (!model) return 'unknown';
    if (model.includes('opus')) return 'opus';
    if (model.includes('sonnet')) return 'sonnet';
    if (model.includes('haiku')) return 'haiku';
    return 'unknown';
  }

  function calcCost(tier, tokens) {
    const p = pricing[tier] || pricing.opus; // unknown models billed at opus rate (safe assumption)
    const m = 1_000_000;
    return (tokens.input / m * p.input) +
           (tokens.output / m * p.output) +
           (tokens.cacheRead / m * p.cacheRead) +
           (tokens.cacheWrite / m * p.cacheWrite);
  }

  // Convert a UTC ISO timestamp string to local YYYY-MM-DD
  function utcToLocalDate(isoStr) {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Recursively find all .jsonl files under projects dir.
  // We no longer filter by mtime — instead we rely on per-message timestamp filtering.
  // Only skip files that haven't been modified in 7+ days to avoid scanning ancient files.
  function findJsonlFiles(dir, project, sessionId) {
    const results = [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Derive session ID from UUID-shaped directory names
        const sid = /^[0-9a-f]{8}-/.test(entry.name) ? entry.name : sessionId;
        results.push(...findJsonlFiles(fp, project, sid));
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const fstat = fs.statSync(fp);
          // Skip files not touched in 7 days — they can't have today's messages
          if (fstat.mtimeMs < cutoff) continue;
          const sid = sessionId || entry.name.replace('.jsonl', '');
          results.push({ path: fp, sessionId: sid, project });
        } catch { /* skip */ }
      }
    }
    return results;
  }

  let sessionFiles;
  try {
    sessionFiles = [];
    for (const proj of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, proj);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
      } catch { continue; }
      sessionFiles.push(...findJsonlFiles(projDir, proj, null));
    }
  } catch {
    return { byModel: {}, bySession: {}, totalCost: 0 };
  }

  for (const sf of sessionFiles) {
    let content;
    try { content = fs.readFileSync(sf.path, 'utf-8'); } catch { continue; }
    const lines = content.trim().split('\n');

    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.message?.usage) continue;

      // Filter by timestamp — convert UTC timestamp to local date for accurate comparison
      if (msg.timestamp) {
        const msgLocalDate = utcToLocalDate(msg.timestamp);
        if (msgLocalDate !== targetDate) continue;
      }

      const u = msg.message.usage;
      const model = msg.message.model || 'unknown';
      const tier = getTier(model);

      const tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
      };

      // Aggregate by model tier
      if (!byModel[tier]) byModel[tier] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
      byModel[tier].input += tokens.input;
      byModel[tier].output += tokens.output;
      byModel[tier].cacheRead += tokens.cacheRead;
      byModel[tier].cacheWrite += tokens.cacheWrite;
      byModel[tier].calls++;

      const cost = calcCost(tier, tokens);
      byModel[tier].cost += cost;
      totalCost += cost;

      // Track most recent session
      if (msg.timestamp && msg.timestamp > latestTimestamp) {
        latestTimestamp = msg.timestamp;
        latestSessionId = sf.sessionId;
      }

      // Aggregate by session
      const sid = sf.sessionId;
      if (!bySession[sid]) bySession[sid] = { cost: 0, calls: 0, models: {}, project: sf.project };
      bySession[sid].cost += cost;
      bySession[sid].calls++;
      bySession[sid].models[tier] = (bySession[sid].models[tier] || 0) + 1;
    }
  }

  // Determine the dominant model of the most recent session
  let latestSessionModel = null;
  if (latestSessionId && bySession[latestSessionId]) {
    const models = bySession[latestSessionId].models;
    latestSessionModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  return { byModel, bySession, totalCost, latestSessionModel };
}

module.exports = {
  CLAUDE_DIR,
  readStatsCache,
  readHistory,
  readSessions,
  readGlobalSettings,
  readProjectSettings,
  readDailyLogs,
  readTaskLog,
  getProjects,
  getMcpServers,
  analyzeRouting,
  readRuns,
  readBenchmarkSummary,
  readSessionTokenUsage,
};
