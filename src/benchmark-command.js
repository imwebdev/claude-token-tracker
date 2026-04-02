const { buildBenchmarks, readBenchmarks } = require('./benchmarks');
const ledger = require('./ledger');

function printBenchmarks() {
  const runs = ledger.listRuns();
  const benchmarks = runs.length ? buildBenchmarks(runs) : readBenchmarks();

  console.log('\n  Token Coach — Benchmarks\n');
  console.log(`  Generated: ${benchmarks.generatedAt || 'N/A'}\n`);

  if (!benchmarks.byFamily.length) {
    console.log('  No benchmark data yet.\n');
    return;
  }

  for (const row of benchmarks.byFamily) {
    console.log(`  ${row.family}/${row.startModel}`);
    if (row.executedRuns > 0) {
      console.log(`    runs: ${row.totalRuns}  executed: ${row.executedRuns}  success: ${(row.successRate * 100).toFixed(0)}%  escalations: ${(row.escalationRate * 100).toFixed(0)}%  route-only: ${row.routeOnlyRuns}\n`);
    } else {
      console.log(`    runs: ${row.totalRuns}  executed: 0  route-only: ${row.routeOnlyRuns}\n`);
    }
  }
}

module.exports = { printBenchmarks };
