/**
 * JSONL transcript scanner.
 *
 * Reads Claude Code's per-session JSONL transcripts from ~/.claude/projects/ (and
 * the Xcode integration dir on macOS) and aggregates token usage into per-day
 * buckets under ~/.token-coach/usage/YYYY-MM-DD.json.
 *
 * Why this exists: stats-cache.json is pre-aggregated, goes stale, and cannot
 * separate cache-creation from cache-read tokens. JSONL transcripts are the
 * ground-truth Claude Code writes on every turn.
 *
 * Dedup: Claude Code logs multiple JSONL records per API response (one per
 * content block) with the same message.id. Last record per id wins — matches
 * phuryn/claude-usage behavior.
 *
 * Incremental: per-file mtime+size gate via ~/.token-coach/scan-manifest.json.
 * Unchanged files keep their cached per-file aggregates; changed files get
 * re-parsed.
 *
 * Inspired by phuryn/claude-usage (MIT). Ported to Node/CommonJS + file-based
 * storage to match this project's zero-deps design.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataHome = require('./data-home');

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const XCODE_PROJECTS = path.join(
  os.homedir(),
  'Library', 'Developer', 'Xcode',
  'CodingAssistant', 'ClaudeAgentConfig', 'projects'
);

const MANIFEST_NAME = 'scan-manifest.json';
const USAGE_DIRNAME = 'usage';

function getManifestPath() {
  return dataHome.getPath(MANIFEST_NAME);
}

function getUsageDir() {
  return dataHome.getPath(USAGE_DIRNAME);
}

function readManifest() {
  const fp = getManifestPath();
  if (!fs.existsSync(fp)) return { files: {}, lastScan: null };
  try {
    const m = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!m || typeof m !== 'object') return { files: {}, lastScan: null };
    if (!m.files || typeof m.files !== 'object') m.files = {};
    return m;
  } catch {
    return { files: {}, lastScan: null };
  }
}

function writeManifest(manifest) {
  dataHome.ensureDataHome();
  fs.writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function* walkJsonl(root) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(fp);
      else if (e.isFile() && fp.endsWith('.jsonl')) yield fp;
    }
  }
}

function isTrackedModel(model) {
  if (!model) return false;
  const s = String(model).toLowerCase();
  return s.includes('opus') || s.includes('sonnet') || s.includes('haiku');
}

/**
 * Parse one JSONL file into per-day×model aggregates.
 *
 * Returns {
 *   daily: {
 *     "YYYY-MM-DD": {
 *       byModel: { "<modelId>": { input, output, cacheRead, cacheWrite, turns } },
 *       sessions: [sessionId, ...]
 *     }
 *   }
 * }
 */
function parseFile(filepath) {
  let raw;
  try { raw = fs.readFileSync(filepath, 'utf-8'); }
  catch { return { daily: {} }; }

  const seenById = new Map();
  const unkeyed = [];

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); }
    catch { continue; }
    if (!rec || rec.type !== 'assistant') continue;

    const msg = rec.message || {};
    const usage = msg.usage || {};
    const model = msg.model;
    if (!isTrackedModel(model)) continue;

    const turn = {
      sessionId: rec.sessionId || '',
      timestamp: rec.timestamp || '',
      model,
      input:      usage.input_tokens || 0,
      output:     usage.output_tokens || 0,
      cacheRead:  usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
    };
    const id = msg.id;
    if (id) seenById.set(id, turn);
    else unkeyed.push(turn);
  }

  const turns = [...seenById.values(), ...unkeyed];
  const daily = {};
  const sessionsByDate = {};

  for (const t of turns) {
    const date = (t.timestamp || '').slice(0, 10);
    if (!date) continue;
    if (!daily[date]) daily[date] = { byModel: {} };
    if (!sessionsByDate[date]) sessionsByDate[date] = new Set();
    if (t.sessionId) sessionsByDate[date].add(t.sessionId);
    const bm = daily[date].byModel;
    if (!bm[t.model]) bm[t.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    bm[t.model].input      += t.input;
    bm[t.model].output     += t.output;
    bm[t.model].cacheRead  += t.cacheRead;
    bm[t.model].cacheWrite += t.cacheWrite;
    bm[t.model].turns      += 1;
  }

  for (const date of Object.keys(daily)) {
    daily[date].sessions = [...sessionsByDate[date]];
  }

  return { daily };
}

function mergeModelBucket(dest, src) {
  dest.input      = (dest.input      || 0) + (src.input      || 0);
  dest.output     = (dest.output     || 0) + (src.output     || 0);
  dest.cacheRead  = (dest.cacheRead  || 0) + (src.cacheRead  || 0);
  dest.cacheWrite = (dest.cacheWrite || 0) + (src.cacheWrite || 0);
  dest.turns      = (dest.turns      || 0) + (src.turns      || 0);
}

function scan(opts = {}) {
  dataHome.ensureDataHome();
  const usageDir = getUsageDir();
  if (!fs.existsSync(usageDir)) fs.mkdirSync(usageDir, { recursive: true });

  const roots = (opts.roots && opts.roots.length)
    ? opts.roots
    : [CLAUDE_PROJECTS, XCODE_PROJECTS].filter(r => fs.existsSync(r));

  const manifest = readManifest();
  const nextFiles = {};
  let filesScanned = 0;
  let filesSkipped = 0;
  let filesRemoved = 0;

  const seenFilepaths = new Set();

  for (const root of roots) {
    for (const fp of walkJsonl(root)) {
      seenFilepaths.add(fp);
      let stat;
      try { stat = fs.statSync(fp); }
      catch { continue; }
      const prev = manifest.files[fp];
      if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size && prev.daily) {
        nextFiles[fp] = prev;
        filesSkipped++;
        continue;
      }
      const { daily } = parseFile(fp);
      nextFiles[fp] = { mtime: stat.mtimeMs, size: stat.size, daily };
      filesScanned++;
    }
  }

  for (const fp of Object.keys(manifest.files)) {
    if (!seenFilepaths.has(fp)) filesRemoved++;
  }

  const dailyAgg = {};
  const sessionsByDate = {};
  for (const entry of Object.values(nextFiles)) {
    for (const [date, perDay] of Object.entries(entry.daily || {})) {
      if (!dailyAgg[date]) dailyAgg[date] = { date, byModel: {} };
      if (!sessionsByDate[date]) sessionsByDate[date] = new Set();
      for (const s of perDay.sessions || []) sessionsByDate[date].add(s);
      for (const [model, bucket] of Object.entries(perDay.byModel || {})) {
        if (!dailyAgg[date].byModel[model]) {
          dailyAgg[date].byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
        }
        mergeModelBucket(dailyAgg[date].byModel[model], bucket);
      }
    }
  }

  for (const [date, d] of Object.entries(dailyAgg)) {
    const out = {
      date,
      sessions: sessionsByDate[date].size,
      byModel: d.byModel,
    };
    fs.writeFileSync(path.join(usageDir, `${date}.json`), JSON.stringify(out, null, 2));
  }

  if (filesRemoved > 0) {
    for (const f of fs.readdirSync(usageDir)) {
      if (!f.endsWith('.json')) continue;
      const date = f.replace(/\.json$/, '');
      if (!dailyAgg[date]) {
        try { fs.unlinkSync(path.join(usageDir, f)); } catch {}
      }
    }
  }

  writeManifest({ files: nextFiles, lastScan: new Date().toISOString() });

  return {
    filesScanned,
    filesSkipped,
    filesRemoved,
    days: Object.keys(dailyAgg).length,
    roots,
  };
}

function readDailyUsage() {
  const dir = getUsageDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))); }
    catch {}
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function summarize(daily = null) {
  const rows = daily || readDailyUsage();
  const totalsByModel = {};
  let sessions = 0;
  for (const d of rows) {
    sessions += d.sessions || 0;
    for (const [model, b] of Object.entries(d.byModel || {})) {
      if (!totalsByModel[model]) totalsByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
      mergeModelBucket(totalsByModel[model], b);
    }
  }
  return { days: rows.length, sessions, byModel: totalsByModel };
}

module.exports = {
  scan,
  readDailyUsage,
  summarize,
  getManifestPath,
  getUsageDir,
  parseFile,
  isTrackedModel,
  CLAUDE_PROJECTS,
  XCODE_PROJECTS,
};
