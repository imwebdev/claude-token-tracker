const ledger = require('./ledger');
const { detectWaste } = require('./waste');

function printAudit() {
  const runs = ledger.listRuns();
  const findings = detectWaste(runs).slice(0, 20);
  const executedRuns = runs.filter(run => run.mode !== 'route-only').length;

  console.log('\n  Token Coach — Audit\n');
  console.log(`  Runs analyzed: ${runs.length}\n`);

  if (!findings.length) {
    if (executedRuns === 0) {
      console.log('  No executed runs yet. Use `token-coach run --execute \"...\"` to collect waste data.\n');
    } else {
      console.log('  No waste findings yet.\n');
    }
    return;
  }

  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.title}`);
    console.log(`    ${finding.detail}\n`);
  }
}

module.exports = { printAudit };
