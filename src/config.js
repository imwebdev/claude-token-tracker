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

// Safe defaults for the routing matrix. Used when the user hasn't customized it.
// Roughly mirrors what the classifier+escalation path would have picked.
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

// Named presets for the matrix (#97). Dashboard exposes these as a dropdown so
// new users get a one-click on-ramp instead of 30 blank cells.
const PRESETS = {
  Balanced: DEFAULT_MATRIX,
  Coder: {
    search_read:  { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    code_edit:    { low: 'sonnet', medium: 'opus',   high: 'opus'   },
    multi_file:   { low: 'opus',   medium: 'opus',   high: 'opus'   },
    debug:        { low: 'opus',   medium: 'opus',   high: 'opus'   },
    review:       { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
    plan:         { low: 'sonnet', medium: 'opus',   high: 'opus'   },
    architecture: { low: 'opus',   medium: 'opus',   high: 'opus'   },
    command:      { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    question:     { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
    unknown:      { low: 'sonnet', medium: 'opus',   high: 'opus'   },
  },
  Reader: {
    search_read:  { low: 'haiku',  medium: 'haiku',  high: 'haiku'  },
    code_edit:    { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    multi_file:   { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
    debug:        { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
    review:       { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
    plan:         { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    architecture: { low: 'sonnet', medium: 'opus',   high: 'opus'   },
    command:      { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
    question:     { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
    unknown:      { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
  },
  Budget: {
    search_read:  { low: 'haiku',  medium: 'haiku',  high: 'haiku'  },
    code_edit:    { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
    multi_file:   { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    debug:        { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    review:       { low: 'haiku',  medium: 'haiku',  high: 'haiku'  },
    plan:         { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
    architecture: { low: 'sonnet', medium: 'sonnet', high: 'opus'   },
    command:      { low: 'haiku',  medium: 'haiku',  high: 'sonnet' },
    question:     { low: 'haiku',  medium: 'haiku',  high: 'haiku'  },
    unknown:      { low: 'haiku',  medium: 'sonnet', high: 'sonnet' },
  },
  'Max accuracy': (() => {
    const m = {};
    for (const f of FAMILIES) m[f] = { low: 'opus', medium: 'opus', high: 'opus' };
    return m;
  })(),
};

const DEFAULTS = {
  // Legacy — ignored; kept so old configs don't error.
  routing_preference: 35,

  // Daily budget alerts (USD). null = disabled.
  daily_alert: null,
  daily_cap: null,

  // Dashboard port. null = use default 6099.
  dashboard_port: null,

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

/** Drop deprecated keys, migrate force_model into the matrix if needed (#97). */
function migrate(user) {
  // force_model → routing_matrix: seed every cell to the forced model, record a
  // one-shot migration marker so the UI can explain what happened, then drop.
  if (user.force_model && !user.routing_matrix) {
    const m = {};
    for (const f of FAMILIES) {
      m[f] = { low: user.force_model, medium: user.force_model, high: user.force_model };
    }
    user.routing_matrix = m;
    user._force_model_migrated = user.force_model;
  }
  // Silently drop deprecated keys — they no longer control routing.
  delete user.force_model;
  delete user.default_model;
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
  DEFAULTS, FAMILIES, COMPLEXITIES, DEFAULT_MATRIX, PRESETS,
  read, set, clearCache, configPath,
  getMatrixCell, updateMatrix,
};
