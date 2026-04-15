/**
 * Per-session Read cache — tracks which files have already been read so the
 * PreToolUse hook can hard-block redundant Read tool calls via
 * permissionDecision: "deny".
 *
 * Storage: one JSON file per session at
 *   ~/.token-coach/read-cache/<session_id>.json
 * Hooks are stateless processes; the file backing survives across invocations.
 *
 * Cache entry shape:
 *   {
 *     <absPath>: {
 *       mtime:     number   // file mtimeMs at first read
 *       size:      number   // file size in bytes at first read
 *       lineCount: number   // approximate lines
 *       firstRead: string   // ISO timestamp
 *       range:     { offset?, limit? } | null
 *     },
 *     ...
 *   }
 */
const fs = require('fs');
const path = require('path');
const dataHome = require('./data-home');

const SESSION_TTL_MS = 60 * 60 * 1000; // 1h

function cacheDir() {
  return path.join(dataHome.getDataHome(), 'read-cache');
}

function cacheFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(cacheDir(), `${safe}.json`);
}

function ensure() {
  fs.mkdirSync(cacheDir(), { recursive: true });
}

function loadSession(sessionId) {
  const fp = cacheFile(sessionId);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return {}; }
}

function saveSession(sessionId, state) {
  ensure();
  fs.writeFileSync(cacheFile(sessionId), JSON.stringify(state));
}

function statFile(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    return { mtime: st.mtimeMs, size: st.size };
  } catch { return null; }
}

function countLines(absPath, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) {
      // Estimate rather than reading very large files
      return Math.ceil(st.size / 80);
    }
    const buf = fs.readFileSync(absPath);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n + 1;
  } catch { return 0; }
}

/**
 * Check whether a file has already been read in this session.
 * Returns the cached entry if the file has not changed on disk; null otherwise.
 */
function lookup(sessionId, absPath) {
  if (!sessionId || !absPath) return null;
  const state = loadSession(sessionId);
  const entry = state[absPath];
  if (!entry) return null;
  const st = statFile(absPath);
  if (!st) return null;
  // Invalidate if file changed since first read
  if (st.mtime !== entry.mtime || st.size !== entry.size) return null;
  return entry;
}

/**
 * Record that a file was read by the current session.
 */
function record(sessionId, absPath, extra = {}) {
  if (!sessionId || !absPath) return null;
  const st = statFile(absPath);
  if (!st) return null;
  const state = loadSession(sessionId);
  state[absPath] = {
    mtime: st.mtime,
    size: st.size,
    lineCount: countLines(absPath),
    firstRead: new Date().toISOString(),
    range: extra.range || null,
  };
  saveSession(sessionId, state);
  return state[absPath];
}

/**
 * Invalidate cache entry for a file (after a Write/Edit).
 */
function invalidate(sessionId, absPath) {
  if (!sessionId || !absPath) return false;
  const state = loadSession(sessionId);
  if (!state[absPath]) return false;
  delete state[absPath];
  saveSession(sessionId, state);
  return true;
}

/**
 * Prune session files older than SESSION_TTL_MS. Safe to call from any hook.
 */
function prune() {
  try {
    ensure();
    const now = Date.now();
    for (const f of fs.readdirSync(cacheDir())) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(cacheDir(), f);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > SESSION_TTL_MS) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

/**
 * Produce a short, Claude-readable summary for the deny message.
 */
function summarize(absPath, entry) {
  const rel = path.basename(absPath);
  const age = Math.round((Date.now() - new Date(entry.firstRead).getTime()) / 1000);
  const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
  return `Already read ${rel} (${entry.lineCount} lines) ${ageStr} this session. File unchanged on disk. Use the prior content instead of re-reading.`;
}

module.exports = {
  lookup,
  record,
  invalidate,
  prune,
  summarize,
  _internal: { cacheFile, cacheDir, statFile, countLines },
};
