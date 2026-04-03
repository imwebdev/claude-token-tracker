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

module.exports = {
  logEvent,
  readEvents,
  getRoutingStats,
  DATA_DIR,
  EVENTS_DIR,
};
