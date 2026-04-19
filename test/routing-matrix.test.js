#!/usr/bin/env node
/**
 * Tests for the routing matrix (#95).
 * Run: node test/routing-matrix.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-matrix-'));
process.env.TOKEN_COACH_HOME = TMP;

const config = require('../src/config');
const { suggestMatrix } = require('../src/learner');
const events = require('../src/events');
const learner = require('../src/learner');

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

function resetConfig(obj = {}) {
  fs.writeFileSync(config.configPath(), JSON.stringify(obj, null, 2));
  config.clearCache();
  learner.clearCache();
}

function seedOutcomes(family, model, count, rate = 1.0) {
  for (let i = 0; i < count; i++) {
    events.logEvent('outcome', {
      session_id: `s-${family}-${model}-${i}`,
      family,
      model,
      turn_success: Math.random() < rate,
      was_escalated: false,
    });
  }
  learner.clearCache();
}

console.log('routing-matrix tests\n');

// ─────────────────────────────────────────────────────────────
// Lookup correctness
// ─────────────────────────────────────────────────────────────

test('getMatrixCell returns built-in default when no user matrix', () => {
  resetConfig();
  assert.strictEqual(config.getMatrixCell('search_read', 'low'), 'haiku');
  assert.strictEqual(config.getMatrixCell('debug', 'high'), 'opus');
  assert.strictEqual(config.getMatrixCell('architecture', 'low'), 'opus');
});

test('getMatrixCell falls back to unknown row for unrecognized family', () => {
  resetConfig();
  // unknown defaults: sonnet/sonnet/opus
  assert.strictEqual(config.getMatrixCell('nonexistent', 'low'), 'sonnet');
  assert.strictEqual(config.getMatrixCell('nonexistent', 'high'), 'opus');
});

test('getMatrixCell normalizes unknown complexity to medium', () => {
  resetConfig();
  // search_read/medium default is 'haiku'
  assert.strictEqual(config.getMatrixCell('search_read', 'huge'), 'haiku');
});

test('updateMatrix persists and is returned by getMatrixCell', () => {
  resetConfig();
  config.updateMatrix({ code_edit: { low: 'haiku', medium: 'sonnet', high: 'opus' } });
  assert.strictEqual(config.getMatrixCell('code_edit', 'low'), 'haiku');
  assert.strictEqual(config.getMatrixCell('code_edit', 'high'), 'opus');
  // Other families unchanged
  assert.strictEqual(config.getMatrixCell('debug', 'high'), 'opus');
});

test('updateMatrix merges partial updates without blanking other cells', () => {
  resetConfig();
  config.updateMatrix({ code_edit: { low: 'haiku', medium: 'sonnet', high: 'opus' } });
  config.updateMatrix({ code_edit: { low: 'opus' } });
  assert.strictEqual(config.getMatrixCell('code_edit', 'low'), 'opus');
  assert.strictEqual(config.getMatrixCell('code_edit', 'medium'), 'sonnet');
  assert.strictEqual(config.getMatrixCell('code_edit', 'high'), 'opus');
});

// ─────────────────────────────────────────────────────────────
// force_model migration
// ─────────────────────────────────────────────────────────────

test('force_model seeds every cell on first migrate', () => {
  resetConfig({ force_model: 'haiku' });
  const cfg = config.read();
  assert.strictEqual(cfg.force_model, null, 'force_model should be cleared after migration');
  assert.strictEqual(cfg._force_model_migrated, 'haiku', 'migration marker should record the forced value');
  for (const f of config.FAMILIES) {
    for (const cx of config.COMPLEXITIES) {
      assert.strictEqual(config.getMatrixCell(f, cx), 'haiku', `${f}/${cx} should be seeded to haiku`);
    }
  }
});

test('force_model migration does not overwrite existing matrix', () => {
  resetConfig({
    force_model: 'opus',
    routing_matrix: { code_edit: { low: 'haiku', medium: 'haiku', high: 'haiku' } },
  });
  const cfg = config.read();
  assert.strictEqual(cfg.force_model, 'opus', 'force_model should NOT be touched when matrix already exists');
  assert.strictEqual(config.getMatrixCell('code_edit', 'low'), 'haiku');
});

// ─────────────────────────────────────────────────────────────
// suggestMatrix (learner-derived)
// ─────────────────────────────────────────────────────────────

test('suggestMatrix falls back to DEFAULT_MATRIX when no learner data', () => {
  resetConfig();
  const m = suggestMatrix(config.DEFAULT_MATRIX);
  assert.strictEqual(m.code_edit.medium, config.DEFAULT_MATRIX.code_edit.medium);
  assert.strictEqual(m.search_read.low,   config.DEFAULT_MATRIX.search_read.low);
});

test('suggestMatrix picks cheapest viable model when learner data supports it', () => {
  resetConfig();
  // haiku succeeds 100% on search_read over 20 outcomes
  seedOutcomes('search_read', 'haiku', 20, 1.0);
  const m = suggestMatrix(config.DEFAULT_MATRIX);
  assert.strictEqual(m.search_read.low, 'haiku');
  assert.strictEqual(m.search_read.medium, 'haiku');
  assert.strictEqual(m.search_read.high, 'haiku');
});

test('suggestMatrix skips families with insufficient samples', () => {
  resetConfig();
  // Only 5 outcomes — below MIN_SUGGEST threshold of 10
  seedOutcomes('plan', 'haiku', 5, 1.0);
  const m = suggestMatrix(config.DEFAULT_MATRIX);
  assert.strictEqual(m.plan.medium, config.DEFAULT_MATRIX.plan.medium);
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
