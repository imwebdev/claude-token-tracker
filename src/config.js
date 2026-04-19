/**
 * User configuration — stored at ~/.token-coach/config.json
 * Provides routing preferences and feature toggles.
 */
const fs = require('fs');
const dataHome = require('./data-home');

// Families the classifier emits. Must match TASK_FAMILIES values in src/router.js.
const FAMILIES = [
  'search_read', 'code_edit', 'multi_file', 'debug', 'review',
  'plan', 'architecture', 'command', 'question', 'unknown',
];
const COMPLEXITIES = ['low', 'medium', 'high'];

// Hardcoded safe defaults for the routing matrix (#95). Used when the user has no
// per-cell preference and learner data is insufficient to suggest one. Roughly
// mirrors what the classifier+escalation path would pick today.
const DEFAULT_MATRIX = {
  search_read:  { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
  code_edit:    { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
  multi_file:   { low: 'sonnet', medium: 'opus',   high: 'opus'   },
  debug:        { low: 'sonnet', medium: 'opus',   high: 'opus'   },
  review:       { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
  plan:         { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
  architecture: { low: 'opus',   medium: 'opus',   high: 'opus'   },
  command:      { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
  question:     { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
  unknown:      { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
};

const DEFAULTS = {
  // Default model: where routing starts. Tasks go up or down from here based on complexity.
  // 'haiku'  — start on haiku, upgrade for complex tasks (max savings)
  // 'sonnet' — start on sonnet, haiku for simple tasks, opus for complex (default)
  // 'opus'   — everything runs on opus, no downgrading
  default_model: 'sonnet',

  // Legacy — kept for backward compat; ignored when default_model is set explicitly.
  routing_preference: 35,

  // Daily budget alerts (USD). null = disabled.
  daily_alert: null,
  daily_cap: null,

  // Dashboard port. null = use default 6099.
  dashboard_port: null,

  // DEPRECATED (#95) — migrated into routing_matrix on first load. Still read as
  // a shim for existing configs; remove after 1–2 releases.
  force_model: null,

  // Routing matrix: per-(family × complexity) model choice. When a cell is set,
  // the hook applies it instead of the classifier's recommendation. The dashboard
  // edits this directly. null means "use DEFAULT_MATRIX".
  routing_matrix: null,

  // How many days of event history to keep. Older JSONL files are pruned on dashboard load.
  history_days: 14,

  // Feedback loop: ask users to confirm model choice after a turn.
  // OFF by default — users opt in via dashboard toggle.
  feedback_loop_enabled: false,

  // Fraction of turns to ask for feedback (0.0–1.0). Default: ask 1 in 10.
  // High-confidence classifications (≥0.7) skip regardless of this setting.
  feedback_loop_sample_rate: 0.1,

  // Read deduper: hard-block redundant Read tool calls in the same session
  // via PreToolUse permissionDecision: "deny". Claude sees a summary pointer
  // instead of re-reading the full file. Set to false to disable.
  read_dedupe: true,

  // SessionStart project-map injection: the SessionStart hook injects a
  // pre-built markdown map of the project (files + one-line descriptions)
  // so Claude skips the initial exploration phase. Cached at
  // ~/.token-coach/project-maps/ with a 24h TTL.
  session_start_map: true,
  session_start_map_max_chars: 32000,   // ~= 8k tokens
  session_start_map_ttl_hours: 24,
};

let _cache = null;

function configPath() {
  return dataHome.getConfigPath();
}

/** Migrate legacy keys to current schema. */
function migrate(user) {
  // model_floor → default_model (renamed for clarity)
  if (!user.default_model && user.model_floor) {
    user.default_model = user.model_floor;
  }
  // routing_preference → default_model (oldest compat)
  if (!user.default_model && user.routing_preference != null) {
    const pref = user.routing_preference;
    if (pref <= 25) user.default_model = 'haiku';
    else if (pref <= 75) user.default_model = 'sonnet';
    else user.default_model = 'opus';
  }
  // force_model → routing_matrix (#95): seed every cell to the forced model,
  // then clear force_model so it doesn't fight the matrix on subsequent reads.
  if (user.force_model && !user.routing_matrix) {
    const m = {};
    for (const f of FAMILIES) {
      m[f] = { low: user.force_model, medium: user.force_model, high: user.force_model };
    }
    user.routing_matrix = m;
    user._force_model_migrated = user.force_model;
    user.force_model = null;
  }
  // Strip legacy keys so they don't appear in the runtime config
  delete user.model_floor;
  return user;
}

/**
 * Look up the model for a classified (family, complexity). Returns the
 * configured cell, falling back to DEFAULT_MATRIX, then to 'sonnet' as a
 * last resort.
 */
function getMatrixCell(family, complexity) {
  const cfg = read();
  const fam = FAMILIES.includes(family) ? family : 'unknown';
  const cx = COMPLEXITIES.includes(complexity) ? complexity : 'medium';
  const matrix = cfg.routing_matrix || {};
  const row = matrix[fam] || DEFAULT_MATRIX[fam] || DEFAULT_MATRIX.unknown;
  return row[cx] || DEFAULT_MATRIX[fam][cx] || 'sonnet';
}

/** Merge a partial matrix update into the stored config. Cells not provided stay unchanged. */
function updateMatrix(partial) {
  const cfg = read();
  const current = cfg.routing_matrix || {};
  const next = {};
  for (const f of FAMILIES) {
    const existing = current[f] || DEFAULT_MATRIX[f];
    const incoming = partial?.[f] || {};
    next[f] = {
      low:    incoming.low    || existing.low,
      medium: incoming.medium || existing.medium,
      high:   incoming.high   || existing.high,
    };
  }
  set('routing_matrix', next);
  return next;
}

/** Read config, merging user values over defaults. */
function read() {
  if (_cache) return _cache;
  const fp = configPath();
  let user = {};
  if (fs.existsSync(fp)) {
    try { user = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  _cache = { ...DEFAULTS, ...migrate(user) };
  return _cache;
}

/** Write a config value. */
function set(key, value) {
  const fp = configPath();
  dataHome.ensureDataHome();
  let existing = {};
  if (fs.existsSync(fp)) {
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  existing[key] = value;
  fs.writeFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
  _cache = null; // bust cache
  return existing;
}

/** Clear the in-memory cache (useful after writes). */
function clearCache() {
  _cache = null;
}

module.exports = {
  DEFAULTS, FAMILIES, COMPLEXITIES, DEFAULT_MATRIX,
  read, set, clearCache, configPath,
  getMatrixCell, updateMatrix,
};
