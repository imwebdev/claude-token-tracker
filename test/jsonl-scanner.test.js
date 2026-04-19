#!/usr/bin/env node
/**
 * Tests for src/jsonl-scanner.js.
 * Run: node test/jsonl-scanner.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-jsonl-'));
process.env.TOKEN_COACH_HOME = TMP;

const scanner = require('../src/jsonl-scanner');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.stack || err.message}`);
  }
}

function makeJsonlDir(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proj-'));
  for (const [rel, lines] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n'));
  }
  return root;
}

function assistantTurn({ sessionId = 'sess1', messageId, model = 'claude-sonnet-4-6', timestamp = '2026-04-01T12:00:00Z', input = 100, output = 50, cacheRead = 1000, cacheWrite = 200 }) {
  return {
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  };
}

console.log('jsonl-scanner tests');

test('empty dir produces no usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-empty-'));
  const r = scanner.scan({ roots: [root] });
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.days, 0);
  assert.deepStrictEqual(scanner.readDailyUsage(), []);
});

test('parses assistant turn with four-token breakdown', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [assistantTurn({ messageId: 'm1' })],
  });
  const r = scanner.scan({ roots: [root] });
  assert.strictEqual(r.filesScanned, 1);
  const daily = scanner.readDailyUsage();
  assert.strictEqual(daily.length, 1);
  const bucket = daily[0].byModel['claude-sonnet-4-6'];
  assert.strictEqual(bucket.input, 100);
  assert.strictEqual(bucket.output, 50);
  assert.strictEqual(bucket.cacheRead, 1000);
  assert.strictEqual(bucket.cacheWrite, 200);
  assert.strictEqual(bucket.turns, 1);
});

test('dedupes multiple records sharing message.id (last-write-wins)', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [
      assistantTurn({ messageId: 'same', input: 100, output: 50 }),
      assistantTurn({ messageId: 'same', input: 100, output: 50 }),
      assistantTurn({ messageId: 'same', input: 100, output: 50 }),
    ],
  });
  scanner.scan({ roots: [root] });
  const daily = scanner.readDailyUsage();
  const bucket = daily[0].byModel['claude-sonnet-4-6'];
  assert.strictEqual(bucket.turns, 1, 'three records with same message.id should collapse to one turn');
  assert.strictEqual(bucket.input, 100);
});

test('filters out non-tracked models (local, unknown)', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [
      assistantTurn({ messageId: 'm1', model: 'claude-opus-4-6' }),
      assistantTurn({ messageId: 'm2', model: 'local-llama' }),
      assistantTurn({ messageId: 'm3', model: 'gpt-4' }),
      assistantTurn({ messageId: 'm4', model: 'claude-haiku-4-5-20251001' }),
    ],
  });
  scanner.scan({ roots: [root] });
  const daily = scanner.readDailyUsage();
  const models = Object.keys(daily[0].byModel).sort();
  assert.deepStrictEqual(models, ['claude-haiku-4-5-20251001', 'claude-opus-4-6']);
});

test('isTrackedModel recognizes tier substrings', () => {
  assert.strictEqual(scanner.isTrackedModel('claude-opus-4-7'), true);
  assert.strictEqual(scanner.isTrackedModel('claude-sonnet-4-6'), true);
  assert.strictEqual(scanner.isTrackedModel('claude-haiku-4-5'), true);
  assert.strictEqual(scanner.isTrackedModel('gpt-4'), false);
  assert.strictEqual(scanner.isTrackedModel('local-llama'), false);
  assert.strictEqual(scanner.isTrackedModel(null), false);
  assert.strictEqual(scanner.isTrackedModel(''), false);
});

test('ignores malformed JSONL lines without crashing', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-malformed-'));
  fs.mkdirSync(path.join(dir, 'proj'));
  const fp = path.join(dir, 'proj', 'mixed.jsonl');
  fs.writeFileSync(fp, [
    'not-json',
    '{"type":"assistant","incomplete":',
    JSON.stringify(assistantTurn({ messageId: 'm1' })),
    '',
    '{}',
  ].join('\n'));
  scanner.scan({ roots: [dir] });
  const daily = scanner.readDailyUsage();
  assert.strictEqual(daily.length, 1);
  assert.strictEqual(daily[0].byModel['claude-sonnet-4-6'].turns, 1);
});

test('incremental re-scan skips unchanged files', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [assistantTurn({ messageId: 'm1' })],
    'proj/b.jsonl': [assistantTurn({ messageId: 'm2', sessionId: 'sess2' })],
  });
  const r1 = scanner.scan({ roots: [root] });
  assert.strictEqual(r1.filesScanned, 2);
  assert.strictEqual(r1.filesSkipped, 0);

  const r2 = scanner.scan({ roots: [root] });
  assert.strictEqual(r2.filesScanned, 0);
  assert.strictEqual(r2.filesSkipped, 2);
});

test('re-scans file when mtime changes', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [assistantTurn({ messageId: 'm1' })],
  });
  scanner.scan({ roots: [root] });

  const fp = path.join(root, 'proj', 'a.jsonl');
  const content = fs.readFileSync(fp, 'utf-8');
  fs.writeFileSync(fp, content + '\n' + JSON.stringify(assistantTurn({ messageId: 'm2' })));

  const r = scanner.scan({ roots: [root] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.filesSkipped, 0);

  const daily = scanner.readDailyUsage();
  assert.strictEqual(daily[0].byModel['claude-sonnet-4-6'].turns, 2);
});

test('aggregates turns spanning multiple days into separate buckets', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [
      assistantTurn({ messageId: 'm1', timestamp: '2026-04-01T23:00:00Z' }),
      assistantTurn({ messageId: 'm2', timestamp: '2026-04-02T01:00:00Z' }),
    ],
  });
  scanner.scan({ roots: [root] });
  const daily = scanner.readDailyUsage();
  const dates = daily.map(d => d.date).sort();
  assert.deepStrictEqual(dates, ['2026-04-01', '2026-04-02']);
});

test('summarize produces totals across all days', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const root = makeJsonlDir({
    'proj/a.jsonl': [
      assistantTurn({ messageId: 'm1', input: 100, output: 50, timestamp: '2026-04-01T12:00:00Z' }),
      assistantTurn({ messageId: 'm2', input: 200, output: 80, timestamp: '2026-04-02T12:00:00Z' }),
    ],
  });
  scanner.scan({ roots: [root] });
  const s = scanner.summarize();
  assert.strictEqual(s.days, 2);
  const b = s.byModel['claude-sonnet-4-6'];
  assert.strictEqual(b.input, 300);
  assert.strictEqual(b.output, 130);
  assert.strictEqual(b.turns, 2);
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
