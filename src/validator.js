function validateResult(classification, result) {
  const family = classification?.family || 'unknown';
  const output = String(result?.output || '').trim();
  const stderr = String(result?.stderr || '').trim();
  const exitCode = result?.exitCode;
  const changedFiles = result?.changedFiles || [];
  const reasons = [];
  let score = 1;
  const infrastructureFailure = /ETIMEDOUT|ENOENT|spawnSync|not found/i.test(stderr);

  if (exitCode !== 0) {
    reasons.push(`command exited with code ${exitCode}`);
    score -= 0.7;
  }

  if (!output) {
    reasons.push('empty output');
    score -= 0.5;
  }

  if (stderr && /error|failed|exception/i.test(stderr)) {
    reasons.push('stderr contains failure markers');
    score -= 0.3;
  }

  if (['review', 'plan'].includes(family) && output.length < 120) {
    reasons.push('response too short for reasoning-heavy task');
    score -= 0.25;
  }

  if (family === 'search_read' && output.length < 40) {
    reasons.push('response too short for discovery task');
    score -= 0.2;
  }

  if (['code_edit', 'debug', 'command'].includes(family) && changedFiles.length === 0) {
    reasons.push('no file changes detected for an execution-oriented task');
    score -= 0.35;
  }

  if (['code_edit', 'debug', 'command'].includes(family) && changedFiles.length > 0) {
    score += 0.15;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    ok: score >= 0.6,
    score,
    reasons,
    needsEscalation: score < 0.6 && !infrastructureFailure,
    infrastructureFailure,
  };
}

module.exports = { validateResult };
