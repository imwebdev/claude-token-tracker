function detectWaste(runs = []) {
  const findings = [];

  for (const run of runs) {
    const attempts = run.attempts || [];
    const startModel = run.recommendation?.model;
    const finalModel = run.finalModel || startModel;
    if (run.mode === 'route-only') continue;

    if (startModel === 'opus' && run.classification?.family === 'search_read') {
      findings.push({
        type: 'over-routing',
        severity: 'warning',
        title: 'Discovery task started too high',
        detail: `${run.id} started on Opus for a discovery-oriented task.`,
      });
    }

    if (attempts.length > 1 && finalModel !== startModel) {
      findings.push({
        type: 'escalation',
        severity: 'warning',
        title: 'Escalation occurred',
        detail: `${run.id} escalated from ${startModel} to ${finalModel}.`,
      });
    }
  }

  return findings;
}

module.exports = { detectWaste };
