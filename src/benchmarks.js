const dataHome = require('./data-home');
const ledger = require('./ledger');
const storage = require('./storage');

function buildBenchmarks(runs = ledger.listRuns()) {
  const byFamily = {};

  for (const run of runs) {
    const family = run.classification?.family || 'unknown';
    const startModel = run.recommendation?.model || 'unknown';
    const key = `${family}:${startModel}`;
    if (!byFamily[key]) {
      byFamily[key] = {
        family,
        startModel,
        totalRuns: 0,
        executedRuns: 0,
        successes: 0,
        escalations: 0,
        routeOnlyRuns: 0,
      };
    }

    const row = byFamily[key];
    row.totalRuns++;
    if (run.mode === 'route-only') {
      row.routeOnlyRuns++;
    } else {
      row.executedRuns++;
      if (run.outcome === 'success') row.successes++;
      if ((run.attempts || []).length > 1) row.escalations++;
    }
  }

  const benchmarks = {
    generatedAt: new Date().toISOString(),
    byFamily: Object.values(byFamily).map(row => ({
      ...row,
      successRate: row.executedRuns > 0 ? row.successes / row.executedRuns : null,
      escalationRate: row.executedRuns > 0 ? row.escalations / row.executedRuns : null,
    })),
  };

  storage.writeJson(dataHome.getBenchmarksDir('task-types.json'), benchmarks);
  return benchmarks;
}

function readBenchmarks() {
  return storage.readJson(dataHome.getBenchmarksDir('task-types.json'), {
    generatedAt: null,
    byFamily: [],
  });
}

module.exports = {
  buildBenchmarks,
  readBenchmarks,
};
