/**
 * Event logger — writes structured JSONL events to ~/.token-coach/events/
 * Each event is one line of JSON, rotated daily.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.TOKEN_COACH_HOME || path.join(os.homedir(), '.token-coach');
const EVENTS_DIR = path.join(DATA_DIR, 'events');

function ensureDirs() {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function now() {
  // Local ISO string instead of UTC — matches user's timezone
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  const sign = off <= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const absM = String(Math.abs(off) % 60).padStart(2, '0');
  return local.toISOString().replace('Z', `${sign}${absH}:${absM}`);
}

/**
 * Append a structured event to the daily JSONL file.
 * @param {string} type - Event type (routing_decision, tool_call, session_start, etc.)
 * @param {object} data - Event payload
 */
function logEvent(type, data) {
  ensureDirs();
  const event = {
    ts: now(),
    type,
    ...data,
  };
  const file = path.join(EVENTS_DIR, `${today()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
  return event;
}

/**
 * Read all events, optionally filtered by date range and type.
 * @param {object} opts - { since?: string (YYYY-MM-DD), type?: string, limit?: number }
 */
function readEvents(opts = {}) {
  ensureDirs();
  const files = fs.readdirSync(EVENTS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  const since = opts.since || '1970-01-01';
  const events = [];

  for (const f of files) {
    const date = f.replace('.jsonl', '');
    if (date < since) continue;

    const lines = fs.readFileSync(path.join(EVENTS_DIR, f), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (opts.type && ev.type !== opts.type) continue;
        events.push(ev);
      } catch {}
    }
  }

  if (opts.limit) return events.slice(-opts.limit);
  return events;
}

/**
 * Get routing stats summary.
 * Combines routing_decision events (what was recommended) with
 * subagent_dispatch events (what actually ran) for accurate delegation tracking.
 */
function getRoutingStats(opts = {}) {
  const allEvents = readEvents(opts);
  const decisions = allEvents.filter(e => e.type === 'routing_decision');
  const dispatches = allEvents.filter(e => e.type === 'subagent_dispatch');

  const stats = {
    total: decisions.length,
    byRecommended: { opus: 0, sonnet: 0, haiku: 0 },
    dispatches: { opus: 0, sonnet: 0, haiku: 0 },
    delegated: dispatches.length, // every subagent dispatch IS a delegation
    optimal: dispatches.filter(d => d.is_optimal).length,
    suboptimal: dispatches.filter(d => !d.is_optimal).length,
    delegationRate: decisions.length > 0
      ? Math.round(dispatches.length / decisions.length * 100) : 0,
    decisions: decisions.slice(-50).reverse(),
    recentDispatches: dispatches.slice(-20).reverse(),
  };

  for (const ev of decisions) {
    const rec = ev.recommended_model || 'sonnet';
    stats.byRecommended[rec] = (stats.byRecommended[rec] || 0) + 1;
  }

  for (const ev of dispatches) {
    const model = ev.model_used || 'opus';
    stats.dispatches[model] = (stats.dispatches[model] || 0) + 1;
  }

  return stats;
}

/**
 * Get per-session costs from actual Claude Code session token usage.
 * Reads real token counts from session JSONL files instead of estimating.
 * Returns { sessions: { [session_id]: { prompts, estimatedCost, models, lastActivity } } }
 */
function getSessionCosts() {
  const parser = require('./parser');
  const todayStr = today();

  // Get real token usage from session files
  const realUsage = parser.readSessionTokenUsage(todayStr);

  // Also get event data for metadata (lastActivity, project names, prompt counts)
  const allEvents = readEvents({ since: todayStr });
  const eventMeta = {};
  for (const ev of allEvents) {
    const sid = ev.session_id;
    if (!sid) continue;
    if (!eventMeta[sid]) {
      eventMeta[sid] = { prompts: 0, lastActivity: ev.ts, project: ev.project || 'unknown', models: {} };
    }
    eventMeta[sid].lastActivity = ev.ts;
    if (ev.type === 'routing_decision') {
      eventMeta[sid].prompts++;
      const model = ev.recommended_model || 'opus';
      eventMeta[sid].models[model] = (eventMeta[sid].models[model] || 0) + 1;
    } else if (ev.type === 'subagent_dispatch') {
      const model = ev.model_used || 'sonnet';
      eventMeta[sid].models[model] = (eventMeta[sid].models[model] || 0) + 1;
    }
  }

  // Merge real usage with event metadata
  const sessions = {};

  // Add sessions from real token usage
  for (const [sid, usage] of Object.entries(realUsage.bySession)) {
    const meta = eventMeta[sid] || {};
    sessions[sid] = {
      prompts: usage.calls || meta.prompts || 0,
      estimatedCost: usage.cost,
      models: usage.models || meta.models || {},
      lastActivity: meta.lastActivity || null,
      project: usage.project || meta.project || 'unknown',
    };
  }

  // Add sessions from events that weren't in session files (edge case)
  for (const [sid, meta] of Object.entries(eventMeta)) {
    if (!sessions[sid]) {
      sessions[sid] = {
        prompts: meta.prompts,
        estimatedCost: 0, // no real data available
        models: meta.models,
        lastActivity: meta.lastActivity,
        project: meta.project,
      };
    }
  }

  return { sessions };
}

/**
 * Get cost for a specific session.
 */
function getSessionCost(sessionId) {
  const { sessions } = getSessionCosts();
  return sessions[sessionId] || { prompts: 0, estimatedCost: 0, models: {}, lastActivity: null };
}

/**
 * Legacy estimate — kept for fallback if session files aren't available.
 */
function estimatePromptCost(model) {
  const tier = (model || 'opus').includes('opus') ? 'opus'
    : (model || '').includes('sonnet') ? 'sonnet'
    : (model || '').includes('haiku') ? 'haiku' : 'opus';
  const costs = { haiku: 0.006, sonnet: 0.018, opus: 0.09 }; // rough per-prompt
  return costs[tier] || costs.opus;
}

/**
 * Identify token-hungry MCP servers, skills, agents, and processes.
 * Analyzes tool_call and subagent_dispatch events to find top consumers.
 */
function getTokenHogs() {
  const allEvents = readEvents({});
  const toolCalls = allEvents.filter(e => e.type === 'tool_call');
  const dispatches = allEvents.filter(e => e.type === 'subagent_dispatch');

  // MCP server call counts
  const mcpServers = {};
  const skills = {};
  const agentTypes = {};
  const allTools = {};

  for (const ev of toolCalls) {
    const tool = ev.tool || '';
    allTools[tool] = (allTools[tool] || 0) + 1;

    if (tool.startsWith('mcp__')) {
      const parts = tool.split('__');
      const server = parts[1] || 'unknown';
      if (!mcpServers[server]) mcpServers[server] = { calls: 0, tools: {} };
      mcpServers[server].calls++;
      const toolName = parts.slice(2).join('__') || tool;
      mcpServers[server].tools[toolName] = (mcpServers[server].tools[toolName] || 0) + 1;
    }

    if (tool === 'Skill') {
      const skillName = (ev.summary || '').replace('Skill:', '').trim() || 'unknown';
      skills[skillName] = (skills[skillName] || 0) + 1;
    }
  }

  for (const ev of dispatches) {
    const agentType = ev.agent_type || 'general-purpose';
    if (!agentTypes[agentType]) agentTypes[agentType] = { dispatches: 0, models: {} };
    agentTypes[agentType].dispatches++;
    const model = ev.model_used || 'opus';
    agentTypes[agentType].models[model] = (agentTypes[agentType].models[model] || 0) + 1;
  }

  // Sort by call count
  const sortedMcp = Object.entries(mcpServers).sort((a, b) => b[1].calls - a[1].calls);
  const sortedAgents = Object.entries(agentTypes).sort((a, b) => b[1].dispatches - a[1].dispatches);
  const sortedTools = Object.entries(allTools).sort((a, b) => b[1] - a[1]);

  return {
    mcpServers: sortedMcp.map(([name, data]) => ({ name, ...data })),
    skills: Object.entries(skills).sort((a, b) => b[1] - a[1]).map(([name, calls]) => ({ name, calls })),
    agentTypes: sortedAgents.map(([name, data]) => ({ name, ...data })),
    topTools: sortedTools.slice(0, 15).map(([name, calls]) => ({ name, calls })),
    totalToolCalls: toolCalls.length,
    totalDispatches: dispatches.length,
  };
}

/**
 * Get the last N events for a specific session, optionally filtered by type.
 * Reads only today's file for performance (sessions don't span days).
 */
function getSessionEvents(sessionId, opts = {}) {
  if (!sessionId) return [];
  const file = path.join(EVENTS_DIR, `${today()}.jsonl`);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
  const results = [];

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.session_id !== sessionId) continue;
      if (opts.type && ev.type !== opts.type) continue;
      results.push(ev);
    } catch {}
  }

  if (opts.limit) return results.slice(-opts.limit);
  return results;
}

/**
 * Get the most recent routing decision for a session.
 */
function getLastRoutingDecision(sessionId) {
  const decisions = getSessionEvents(sessionId, { type: 'routing_decision' });
  return decisions.length > 0 ? decisions[decisions.length - 1] : null;
}

module.exports = {
  logEvent,
  readEvents,
  getRoutingStats,
  getSessionCosts,
  getSessionCost,
  estimatePromptCost,
  getTokenHogs,
  getSessionEvents,
  getLastRoutingDecision,
  DATA_DIR,
  EVENTS_DIR,
};
