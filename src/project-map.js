/**
 * Project-map generator — walks a project directory and emits a compact
 * markdown summary that the SessionStart hook injects into Claude Code's
 * context. Kills the "what's in this repo?" exploration phase at session
 * open, targeting ~15–25% reduction on startup tokens.
 *
 * Heuristic only in v1: first meaningful comment/line per file, grouped by
 * directory. No LLM call. Cached at ~/.token-coach/project-maps/<slug>.md
 * with a 24h TTL and sidecar <slug>.json metadata.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataHome = require('./data-home');

// ── Tunables ─────────────────────────────────────────────────────────────
const DEFAULT_MAX_CHARS = 32000;        // ≈ 8k tokens
const DEFAULT_TTL_HOURS = 24;
const MAX_FILES = 500;
const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 256 * 1024;      // skip files > 256KB (big configs/logs)

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache',
  'vendor', '.idea', '.vscode', '.claude', '.token-coach',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm', '.avi',
  '.ttf', '.woff', '.woff2', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.wasm',
  '.lock', '.map', '.min.js', '.min.css',
]);

// Files that deserve priority treatment (described first, never truncated)
const PRIORITY_NAMES = new Set([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Gemfile', 'composer.json', 'build.gradle', 'pom.xml',
  'README.md', 'README', 'CLAUDE.md', 'CONTRIBUTING.md',
  'Dockerfile', 'docker-compose.yml', 'Makefile',
  '.eslintrc.json', '.prettierrc', 'vite.config.ts', 'next.config.js',
]);

// ── File summary extraction ──────────────────────────────────────────────

/** Extract a one-line description from a source file (~80 chars). */
function describeFile(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const ext = path.extname(fp).toLowerCase();
    if (BINARY_EXT.has(ext)) return null;

    const raw = fs.readFileSync(fp, 'utf-8');
    // Quick binary sniff — if NUL bytes in first 512, treat as binary
    if (raw.slice(0, 512).includes('\u0000')) return null;

    const lines = raw.split('\n');
    let desc = null;

    // 1. Try a leading block comment (/** ... */, """ ... """)
    const joined = raw.slice(0, 1024);
    const blockMatch = joined.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*@]{8,160})/)
      || joined.match(/^"""\s*\n?\s*([^\n"]{8,160})/m)
      || joined.match(/^'''\s*\n?\s*([^\n']{8,160})/m);
    if (blockMatch) desc = blockMatch[1].trim();

    // 2. Fall back to the first meaningful line comment
    if (!desc) {
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const m = line.match(/^(?:\/\/|#|--|;)\s*(.{8,160})/);
        if (m) { desc = m[1].trim(); break; }
      }
    }

    // 3. Fall back to the first non-empty code line (heavily truncated)
    if (!desc) {
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith('#!') && !t.startsWith('<?')) {
          desc = t.slice(0, 80);
          break;
        }
      }
    }

    if (!desc) return null;
    return desc.replace(/\s+/g, ' ').slice(0, 100);
  } catch { return null; }
}

// ── Directory walker ─────────────────────────────────────────────────────

/** Walk the project dir and return [{ relPath, size, priority }, ...] */
function walkProject(rootDir) {
  const files = [];
  function recurse(dir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= MAX_FILES) return;
      if (ent.name.startsWith('.') && !PRIORITY_NAMES.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        recurse(abs, depth + 1);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { continue; }
        if (size > MAX_FILE_BYTES) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        files.push({
          relPath: path.relative(rootDir, abs),
          size,
          priority: PRIORITY_NAMES.has(ent.name),
        });
      }
    }
  }
  recurse(rootDir, 0);
  return files;
}

// ── Markdown emission ────────────────────────────────────────────────────

/** Render files into a markdown tree grouped by top-level directory. */
function renderMarkdown(rootDir, files, maxChars) {
  const projectName = path.basename(rootDir);
  const buckets = { '.': [] };

  // Sort: priority first, then alphabetical
  files.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return a.relPath.localeCompare(b.relPath);
  });

  for (const f of files) {
    const top = f.relPath.includes(path.sep) ? f.relPath.split(path.sep)[0] : '.';
    if (!buckets[top]) buckets[top] = [];
    buckets[top].push(f);
  }

  let out = `# Project map: ${projectName}\n\n`;
  out += `Auto-generated by claude-token-tracker to reduce exploration-phase tokens.\n`;
  out += `Root: \`${rootDir}\` · ${files.length} files indexed.\n\n`;

  const bucketOrder = ['.', ...Object.keys(buckets).filter(k => k !== '.').sort()];

  for (const bucket of bucketOrder) {
    const list = buckets[bucket];
    if (!list || !list.length) continue;
    out += bucket === '.' ? `## (root)\n\n` : `## ${bucket}/\n\n`;
    for (const f of list) {
      if (out.length >= maxChars) {
        out += `\n_... truncated to fit ${maxChars} char budget_\n`;
        return out;
      }
      const abs = path.join(rootDir, f.relPath);
      const desc = describeFile(abs);
      const line = desc
        ? `- \`${f.relPath}\` — ${desc}\n`
        : `- \`${f.relPath}\`\n`;
      out += line;
    }
    out += '\n';
  }
  return out;
}

// ── Cache IO ─────────────────────────────────────────────────────────────

function mapsDir() {
  return dataHome.getPath('project-maps');
}

function projectKey(rootDir) {
  const slug = dataHome.normalizeProjectSlug(rootDir);
  const hash = crypto.createHash('sha1').update(rootDir).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function mapPaths(rootDir) {
  const key = projectKey(rootDir);
  const dir = mapsDir();
  return { md: path.join(dir, `${key}.md`), meta: path.join(dir, `${key}.json`) };
}

function readMeta(metaPath) {
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
  catch { return null; }
}

function isFresh(meta, ttlHours) {
  if (!meta || !meta.generated_at) return false;
  const age = Date.now() - new Date(meta.generated_at).getTime();
  return age < ttlHours * 60 * 60 * 1000;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate the map for `rootDir` and write it to the cache.
 * Always overwrites. Returns { md, path, fileCount, bytes }.
 */
function generateMap(rootDir, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  fs.mkdirSync(mapsDir(), { recursive: true });
  const files = walkProject(rootDir);
  const md = renderMarkdown(rootDir, files, maxChars);
  const { md: mdPath, meta: metaPath } = mapPaths(rootDir);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(metaPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    project_path: rootDir,
    file_count: files.length,
    bytes: Buffer.byteLength(md),
  }, null, 2));
  return { md, path: mdPath, fileCount: files.length, bytes: Buffer.byteLength(md) };
}

/**
 * Return cached map if fresh, otherwise generate one.
 * Returns null if `rootDir` is not a readable directory.
 */
function getOrGenerate(rootDir, opts = {}) {
  if (!rootDir) return null;
  try {
    if (!fs.statSync(rootDir).isDirectory()) return null;
  } catch { return null; }

  const ttl = opts.ttlHours || DEFAULT_TTL_HOURS;
  const { md: mdPath, meta: metaPath } = mapPaths(rootDir);
  const meta = readMeta(metaPath);

  if (meta && isFresh(meta, ttl) && fs.existsSync(mdPath)) {
    try {
      return {
        md: fs.readFileSync(mdPath, 'utf-8'),
        path: mdPath,
        fromCache: true,
        fileCount: meta.file_count,
        generated_at: meta.generated_at,
      };
    } catch { /* fall through to regenerate */ }
  }

  const result = generateMap(rootDir, opts);
  return { ...result, fromCache: false, generated_at: new Date().toISOString() };
}

module.exports = {
  generateMap,
  getOrGenerate,
  mapPaths,
  _internal: { walkProject, describeFile, renderMarkdown, projectKey, isFresh },
  DEFAULT_MAX_CHARS,
  DEFAULT_TTL_HOURS,
};
