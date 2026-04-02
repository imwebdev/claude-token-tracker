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
function getMcpServers(globalSettings, projectSettings) {
  const servers = new Set();
  const disabled = new Set();

  if (projectSettings?.disabledMcpServers) {
    projectSettings.disabledMcpServers.forEach(s => disabled.add(s));
  }

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
};
