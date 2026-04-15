#!/usr/bin/env node
/**
 * Tests for events.getDedupeStats aggregator.
 * Run: node test/dedupe-stats.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dedupe-'));
process.env.TOKEN_COACH_HOME = TMP;

const events = require('../src/events');

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

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

console.log('getDedupeStats tests');

test('empty event log returns zeros', () => {
  const stats = events.getDedupeStats();
  assert.strictEqual(stats.total, 0);
  assert.strictEqual(stats.totalLines, 0);
  assert.strictEqual(stats.totalTokens, 0);
  assert.deepStrictEqual(stats.daily, []);
});

test('single read_deduped event aggregated correctly', () => {
  events.logEvent('read_deduped', {
    session_id: 's1',
    project: 'demo',
    file_path: '/tmp/foo.ts',
    line_count: 100,
    first_read_at: new Date().toISOString(),
  });
  const stats = events.getDedupeStats();
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.totalLines, 100);
  assert.strictEqual(stats.totalTokens, 350); // 100 × 3.5
  assert.strictEqual(stats.daily.length, 1);
  assert.strictEqual(stats.daily[0].reads, 1);
  assert.strictEqual(stats.daily[0].lines, 100);
  assert.strictEqual(stats.daily[0].tokens, 350);
  assert.strictEqual(stats.daily[0].date, today());
});

test('multiple events same day aggregate', () => {
  events.logEvent('read_deduped', { session_id: 's2', file_path: '/a', line_count: 50 });
  events.logEvent('read_deduped', { session_id: 's2', file_path: '/b', line_count: 200 });
  const stats = events.getDedupeStats();
  // We have 1 from the previous test + 2 new = 3 total, 100+50+200 = 350 lines
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.totalLines, 350);
  // Still one day, since all events were today
  assert.strictEqual(stats.daily.length, 1);
  assert.strictEqual(stats.daily[0].reads, 3);
});

test('non-dedupe events are ignored', () => {
  events.logEvent('routing_decision', { session_id: 's3', prompt_preview: 'ignore me' });
  events.logEvent('tool_call', { session_id: 's3', tool: 'Bash' });
  const stats = events.getDedupeStats();
  assert.strictEqual(stats.total, 3); // unchanged from prior test
});

test('tokensPerLine surfaced for transparency', () => {
  const stats = events.getDedupeStats();
  assert.strictEqual(stats.tokensPerLine, 3.5);
});

test('missing line_count defaults to 0', () => {
  // Reset by using a different temp dir via re-require with a fresh HOME
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dedupe-b-'));
  process.env.TOKEN_COACH_HOME = TMP2;
  // Clear require cache so events re-reads env
  delete require.cache[require.resolve('../src/events')];
  const events2 = require('../src/events');
  events2.logEvent('read_deduped', { session_id: 'x', file_path: '/x' });
  const stats = events2.getDedupeStats();
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.totalLines, 0);
  assert.strictEqual(stats.totalTokens, 0);
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch {}
});

// ── Summary ────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);
