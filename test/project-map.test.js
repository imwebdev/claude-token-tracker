#!/usr/bin/env node
/**
 * Tests for src/project-map.js — generator + cache behavior.
 * Run: node test/project-map.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pmap-'));
process.env.TOKEN_COACH_HOME = TMP;

const projectMap = require('../src/project-map');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function makeProject(name, layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tc-proj-${name}-`));
  for (const [rel, contents] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

console.log('project-map tests');

test('generateMap walks a simple project and emits markdown', () => {
  const root = makeProject('simple', {
    'package.json': '{"name":"demo"}',
    'README.md': '# Demo project\nDescribes things.',
    'src/index.js': '// entry point for the demo app\nconsole.log("hi");',
    'src/util.js': '/** Utility helpers for the demo. */\nfunction add(a,b){return a+b;}',
  });
  const result = projectMap.generateMap(root);
  assert.ok(result.md.includes('# Project map'));
  assert.ok(result.md.includes('package.json'));
  assert.ok(result.md.includes('README.md'));
  assert.ok(result.md.includes('src/index.js'));
  assert.ok(result.md.includes('entry point for the demo'));
  assert.ok(result.md.includes('Utility helpers'));
  assert.ok(result.fileCount >= 4);
  fs.rmSync(root, { recursive: true, force: true });
});

test('walkProject skips node_modules, .git, dist', () => {
  const root = makeProject('skips', {
    'index.js': '// entry',
    'node_modules/lodash/index.js': '// should not appear',
    '.git/config': '[core]',
    'dist/bundle.js': '// generated',
    'src/app.js': '// app code',
  });
  const files = projectMap._internal.walkProject(root);
  const paths = files.map(f => f.relPath);
  assert.ok(paths.includes('index.js'));
  assert.ok(paths.includes(path.join('src', 'app.js')));
  assert.ok(!paths.some(p => p.includes('node_modules')));
  assert.ok(!paths.some(p => p.includes('.git')));
  assert.ok(!paths.some(p => p.startsWith('dist')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('skips binary extensions', () => {
  const root = makeProject('binary', {
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary'),
    'src/app.js': '// ok',
  });
  const files = projectMap._internal.walkProject(root);
  assert.ok(!files.some(f => f.relPath.endsWith('.png')));
  assert.ok(files.some(f => f.relPath.endsWith('app.js')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('maxChars budget is respected', () => {
  // Build a project larger than 500 chars so truncation kicks in
  const layout = {};
  for (let i = 0; i < 50; i++) {
    layout[`f${i}.js`] = `// file number ${i}\n`.repeat(5);
  }
  const root = makeProject('budget', layout);
  const result = projectMap.generateMap(root, { maxChars: 500 });
  // Output should be bounded (small slop for the truncation marker)
  assert.ok(result.md.length <= 700, `expected <=700 chars, got ${result.md.length}`);
  assert.ok(result.md.includes('truncated'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('getOrGenerate returns fromCache=true on second call', () => {
  const root = makeProject('cache', {
    'a.js': '// a',
    'b.js': '// b',
  });
  const first = projectMap.getOrGenerate(root);
  assert.strictEqual(first.fromCache, false);
  const second = projectMap.getOrGenerate(root);
  assert.strictEqual(second.fromCache, true);
  assert.strictEqual(second.fileCount, first.fileCount);
  fs.rmSync(root, { recursive: true, force: true });
});

test('getOrGenerate regenerates when TTL expired', () => {
  const root = makeProject('stale', { 'x.js': '// x' });
  projectMap.getOrGenerate(root);
  const { meta: metaPath } = projectMap.mapPaths(root);
  // Write a stale metadata timestamp
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.generated_at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const result = projectMap.getOrGenerate(root, { ttlHours: 24 });
  assert.strictEqual(result.fromCache, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('getOrGenerate returns null for missing directory', () => {
  assert.strictEqual(projectMap.getOrGenerate('/tmp/nope-does-not-exist-abc123'), null);
  assert.strictEqual(projectMap.getOrGenerate(null), null);
  assert.strictEqual(projectMap.getOrGenerate(''), null);
});

test('describeFile tolerates files without comments', () => {
  const root = makeProject('nocomment', {
    'raw.txt': 'just some text without any comment markers.',
  });
  const abs = path.join(root, 'raw.txt');
  const desc = projectMap._internal.describeFile(abs);
  assert.ok(typeof desc === 'string');
  assert.ok(desc.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('describeFile returns null for missing file', () => {
  assert.strictEqual(projectMap._internal.describeFile('/tmp/nope-abc-xyz.js'), null);
});

test('priority files surface to the top of their bucket', () => {
  const root = makeProject('priority', {
    'package.json': '{"name":"p"}',
    'zzz-last.js': '// z',
    'aaa-first.js': '// a',
  });
  const result = projectMap.generateMap(root);
  const rootBucket = result.md.split('## ')[1] || '';
  const pkgIdx = rootBucket.indexOf('package.json');
  const aaaIdx = rootBucket.indexOf('aaa-first.js');
  assert.ok(pkgIdx !== -1 && aaaIdx !== -1);
  assert.ok(pkgIdx < aaaIdx, 'package.json should appear before aaa-first.js due to priority');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Summary ────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);
