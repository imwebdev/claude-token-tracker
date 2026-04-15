#!/usr/bin/env node
/**
 * Unit tests for src/read-cache.js
 * Run: node test/read-cache.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect TOKEN_COACH_HOME to a temp dir before loading the module
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-read-cache-'));
process.env.TOKEN_COACH_HOME = TMP;

const readCache = require('../src/read-cache');

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

function makeFile(contents = 'line1\nline2\nline3\n') {
  const fp = path.join(TMP, `sample-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(fp, contents);
  return fp;
}

console.log('read-cache tests');

test('lookup returns null for uncached file', () => {
  const fp = makeFile();
  assert.strictEqual(readCache.lookup('s1', fp), null);
});

test('record + lookup returns entry with lineCount', () => {
  const fp = makeFile('a\nb\nc\nd\n');
  readCache.record('s2', fp);
  const hit = readCache.lookup('s2', fp);
  assert.ok(hit, 'expected cache hit after record');
  assert.strictEqual(hit.lineCount, 5); // 4 newlines + 1
  assert.ok(hit.mtime > 0);
  assert.ok(hit.firstRead);
});

test('lookup invalidates when file mtime changes', () => {
  const fp = makeFile('original\n');
  readCache.record('s3', fp);
  // Wait enough for mtime granularity, then rewrite
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(fp, future, future);
  assert.strictEqual(readCache.lookup('s3', fp), null, 'mtime change should invalidate');
});

test('invalidate() removes entry', () => {
  const fp = makeFile();
  readCache.record('s4', fp);
  assert.ok(readCache.lookup('s4', fp));
  const removed = readCache.invalidate('s4', fp);
  assert.strictEqual(removed, true);
  assert.strictEqual(readCache.lookup('s4', fp), null);
});

test('separate sessions do not share cache', () => {
  const fp = makeFile();
  readCache.record('sA', fp);
  assert.ok(readCache.lookup('sA', fp));
  assert.strictEqual(readCache.lookup('sB', fp), null);
});

test('summarize produces a non-empty human-readable string', () => {
  const fp = makeFile('x\ny\n');
  readCache.record('s5', fp);
  const hit = readCache.lookup('s5', fp);
  const s = readCache.summarize(fp, hit);
  assert.ok(typeof s === 'string' && s.length > 20);
  assert.ok(s.includes('Already read'));
});

test('prune removes old session files', () => {
  const fp = makeFile();
  readCache.record('s-old', fp);
  const cacheFile = readCache._internal.cacheFile('s-old');
  // Age it past the 1h TTL
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(cacheFile, old, old);
  readCache.prune();
  assert.strictEqual(fs.existsSync(cacheFile), false);
});

test('missing sessionId or path returns gracefully', () => {
  assert.strictEqual(readCache.lookup(null, '/tmp/x'), null);
  assert.strictEqual(readCache.lookup('s', null), null);
  assert.strictEqual(readCache.record(null, '/tmp/x'), null);
  assert.strictEqual(readCache.invalidate(null, null), false);
});

test('lookup returns null for non-existent file', () => {
  readCache.record('s6', path.join(TMP, 'nope-does-not-exist.txt'));
  assert.strictEqual(readCache.lookup('s6', path.join(TMP, 'nope-does-not-exist.txt')), null);
});

// ── Summary ────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

// Cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
