const crypto = require('crypto');
const path = require('path');
const dataHome = require('./data-home');
const storage = require('./storage');

function timestampParts(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day };
}

function createRunId(date = new Date()) {
  return `${date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

function getRunFilePath(runId, date = new Date()) {
  const { year, month, day } = timestampParts(date);
  return dataHome.getRunsDir(year, month, day, `${runId}.json`);
}

function getEventFilePath(date = new Date()) {
  const { year, month, day } = timestampParts(date);
  return dataHome.getEventsDir(year, month, `${day}.jsonl`);
}

function createAttempt({ model, attemptNumber = 1, trigger = 'initial' }) {
  return {
    model,
    attemptNumber,
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: false,
    exitCode: null,
    output: '',
    stderr: '',
    validation: null,
    tokenUsage: null,
    changedFiles: [],
  };
}

function createRunRecord({
  task,
  cwd,
  classification,
  recommendation,
  mode = 'route-only',
}) {
  const now = new Date();
  return {
    id: createRunId(now),
    task,
    cwd,
    project: dataHome.normalizeProjectSlug(cwd || ''),
    classification,
    recommendation,
    mode,
    attempts: [],
    status: 'started',
    outcome: 'pending',
    wasteFlags: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finalModel: null,
    validation: null,
  };
}

function logEvent(type, payload, date = new Date()) {
  const event = {
    type,
    timestamp: date.toISOString(),
    payload,
  };
  storage.appendJsonl(getEventFilePath(date), event);
  return event;
}

function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  storage.writeJson(getRunFilePath(run.id, new Date(run.createdAt)), run);
  return run;
}

function startRun(input) {
  dataHome.ensureDataHome();
  const run = createRunRecord(input);
  saveRun(run);
  logEvent('run_started', {
    id: run.id,
    task: run.task,
    cwd: run.cwd,
    recommendedModel: run.recommendation?.model || null,
  }, new Date(run.createdAt));
  return run;
}

function appendAttempt(run, attempt) {
  run.attempts.push(attempt);
  saveRun(run);
  logEvent('attempt_started', {
    runId: run.id,
    model: attempt.model,
    attemptNumber: attempt.attemptNumber,
    trigger: attempt.trigger,
  });
  return run;
}

function recordAttemptResult(run, attemptIndex, result) {
  const attempt = run.attempts[attemptIndex];
  if (!attempt) return run;

  attempt.finishedAt = new Date().toISOString();
  attempt.success = Boolean(result.success);
  attempt.exitCode = result.exitCode;
  attempt.output = result.output || '';
  attempt.stderr = result.stderr || '';
  attempt.validation = result.validation || null;
  attempt.tokenUsage = result.tokenUsage || null;
  attempt.changedFiles = result.changedFiles || [];

  saveRun(run);
  logEvent('attempt_finished', {
    runId: run.id,
    model: attempt.model,
    attemptNumber: attempt.attemptNumber,
    success: attempt.success,
    exitCode: attempt.exitCode,
  });
  return run;
}

function finishRun(run, fields = {}) {
  Object.assign(run, fields);
  run.updatedAt = new Date().toISOString();
  saveRun(run);
  logEvent('run_finished', {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    finalModel: run.finalModel,
  });
  return run;
}

function listRuns() {
  return storage.listFilesRecursive(dataHome.getRunsDir(), '.json')
    .map(filePath => storage.readJson(filePath))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  appendAttempt,
  createAttempt,
  createRunId,
  createRunRecord,
  finishRun,
  getEventFilePath,
  getRunFilePath,
  listRuns,
  logEvent,
  recordAttemptResult,
  saveRun,
  startRun,
};
