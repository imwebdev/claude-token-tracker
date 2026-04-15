#!/usr/bin/env node
/**
 * Tests for install-meta (#82 install-date marker) and calculator.buildDailyCostSeries.
 * Run: node test/install-cost.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-cost-'));
process.env.TOKEN_COACH_HOME = TMP;

// Lazy-load modules so TOKEN_COACH_HOME is respected
const installMeta = require('../src/install-meta');
const calculator = require('../src/calculator');

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

console.log('install-meta tests');

test('first recordInstall creates file with created=true', () => {
  const info = installMeta.recordInstall();
  assert.strictEqual(info.created, true);
  assert.ok(info.installed_at);
  assert.ok(Number.isNaN(Date.parse(info.installed_at)) === false, 'installed_at must be valid ISO');
  assert.ok(info.version);
  assert.ok(fs.existsSync(installMeta.installPath()));
});

test('second recordInstall returns same timestamp with created=false (idempotent)', () => {
  const first = installMeta.readInstall();
  const second = installMeta.recordInstall();
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.installed_at, first.installed_at);
});

test('readInstall returns null when file missing', () => {
  fs.rmSync(installMeta.installPath(), { force: true });
  assert.strictEqual(installMeta.readInstall(), null);
});

test('readInstall recovers gracefully from corrupt JSON', () => {
  fs.writeFileSync(installMeta.installPath(), '{ not valid json');
  assert.strictEqual(installMeta.readInstall(), null);
  // Corruption is replaced on next recordInstall
  const info = installMeta.recordInstall();
  assert.ok(info.installed_at);
});

console.log('\nbuildDailyCostSeries tests');

test('empty input returns empty array', () => {
  assert.deepStrictEqual(calculator.buildDailyCostSeries([]), []);
  assert.deepStrictEqual(calculator.buildDailyCostSeries(null), []);
  assert.deepStrictEqual(calculator.buildDailyCostSeries(undefined), []);
});

test('basic shape: date, cost, tokens, byModel', () => {
  const input = [
    {
      date: '2026-04-10',
      tokensByModel: {
        'claude-opus-4-6': 1_000_000,
        'claude-sonnet-4-6': 2_000_000,
      },
    },
  ];
  const series = calculator.buildDailyCostSeries(input);
  assert.strictEqual(series.length, 1);
  const d = series[0];
  assert.strictEqual(d.date, '2026-04-10');
  assert.strictEqual(d.tokens, 3_000_000);
  assert.ok(d.cost > 0);
  assert.ok(d.byModel.opus);
  assert.ok(d.byModel.sonnet);
  assert.strictEqual(d.byModel.opus.tokens, 1_000_000);
  assert.strictEqual(d.byModel.sonnet.tokens, 2_000_000);
  // Opus is more expensive per-token → opus cost > sonnet cost despite fewer tokens? no — sonnet has 2x tokens
  assert.ok(d.byModel.opus.cost > 0);
  assert.ok(d.byModel.sonnet.cost > 0);
});

test('days parameter trims to last N entries', () => {
  const input = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    tokensByModel: { 'claude-haiku-4-5-20251001': 500_000 },
  }));
  const series = calculator.buildDailyCostSeries(input, 3);
  assert.strictEqual(series.length, 3);
  assert.strictEqual(series[0].date, '2026-04-08');
  assert.strictEqual(series[2].date, '2026-04-10');
});

test('cost math: opus tokens should cost more than same haiku tokens', () => {
  const opusOnly = calculator.buildDailyCostSeries([
    { date: '2026-04-10', tokensByModel: { 'claude-opus-4-6': 1_000_000 } },
  ]);
  const haikuOnly = calculator.buildDailyCostSeries([
    { date: '2026-04-10', tokensByModel: { 'claude-haiku-4-5-20251001': 1_000_000 } },
  ]);
  assert.ok(opusOnly[0].cost > haikuOnly[0].cost,
    `opus cost (${opusOnly[0].cost}) should exceed haiku cost (${haikuOnly[0].cost}) for same tokens`);
});

test('unknown model tier falls through gracefully', () => {
  const series = calculator.buildDailyCostSeries([
    { date: '2026-04-10', tokensByModel: { 'mystery-model': 100_000 } },
  ]);
  assert.strictEqual(series.length, 1);
  assert.ok(series[0].cost >= 0); // defaults to opus pricing in getModelPrice
});

// ── Summary ────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed > 0 ? 1 : 0);
