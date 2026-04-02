const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const { buildEscalationChain, getNextModel } = require('./escalation');
const { classifyTask, expectedExecutionMode, recommendModel } = require('./router');
const { validateResult } = require('./validator');

function buildExecutionPrompt(task, cwd) {
  return [
    `Working directory: ${cwd}`,
    'You are being routed by Token Coach.',
    'Execute the user task directly in the working directory when tools or file edits are needed.',
    'Keep changes focused. Do not ask for confirmation. If the task requires file edits, make them.',
    'End your response with a short plain-text summary of what you did.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

function detectChangedFiles(cwd, before, after) {
  const changed = [];
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  for (const relativePath of afterKeys) {
    if (!beforeKeys.has(relativePath) || before[relativePath] !== after[relativePath]) {
      changed.push(relativePath);
    }
  }

  for (const relativePath of beforeKeys) {
    if (!afterKeys.has(relativePath)) {
      changed.push(relativePath);
    }
  }

  return changed.sort().map(relativePath => path.join(cwd, relativePath));
}

function snapshotFiles(cwd) {
  const result = {};
  const maxHashedBytes = 1024 * 1024;

  function fingerprintFile(fullPath) {
    const stat = fs.statSync(fullPath);
    if (stat.size > maxHashedBytes) {
      return `large:${stat.size}:${stat.mtimeMs}`;
    }
    const content = fs.readFileSync(fullPath);
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    return `sha1:${hash}`;
  }

  function walk(currentDir, baseDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath, baseDir);
        continue;
      }
      try {
        result[relativePath] = fingerprintFile(fullPath);
      } catch {}
    }
  }

  walk(cwd, cwd);
  return result;
}

function executePrintMode(model, task, cwd, classification) {
  const beforeFiles = snapshotFiles(cwd);
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'text',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    cwd,
    '--no-session-persistence',
  ];

  const result = spawnSync('claude', args, {
    cwd,
    encoding: 'utf-8',
    input: buildExecutionPrompt(task, cwd),
    timeout: classification?.complexity === 'high' ? 120000 : 60000,
  });
  const afterFiles = snapshotFiles(cwd);
  const changedFiles = detectChangedFiles(cwd, beforeFiles, afterFiles);

  return {
    success: result.status === 0,
    exitCode: result.status ?? 1,
    output: result.stdout || '',
    stderr: result.error ? String(result.error.message || result.error) : (result.stderr || ''),
    changedFiles,
  };
}

function parseRunArgs(args) {
  return {
    dryRun: args.includes('--dry-run'),
    forceExecute: args.includes('--execute'),
  };
}

function formatRunSummary(run) {
  return [
    '',
    '  Token Coach — Run',
    '',
    `  Run ID: ${run.id}`,
    `  Family: ${run.classification.family} (${run.classification.complexity})`,
    `  Recommended: ${run.recommendation.model}`,
    `  Fallbacks: ${run.recommendation.fallbackChain.join(' -> ')}`,
    `  Mode: ${run.mode}`,
    `  Outcome: ${run.outcome}`,
    '',
  ].join('\n');
}

function runTaskCommand(task, args = [], cwd = process.cwd()) {
  if (!task) {
    console.error('No task provided. Usage: token-coach run "your task here"');
    process.exit(1);
  }

  const options = parseRunArgs(args);
  const classification = classifyTask(task);
  const recommendation = recommendModel(classification);
  const autoMode = expectedExecutionMode(classification);
  const mode = options.forceExecute ? autoMode : (options.dryRun ? 'route-only' : 'route-only');
  const run = ledger.startRun({ task, cwd, classification, recommendation, mode });

  if (mode === 'route-only') {
    ledger.finishRun(run, {
      status: 'completed',
      outcome: 'routed',
      finalModel: recommendation.model,
      wasteFlags: ['route-only'],
    });
    console.log(formatRunSummary(run));
    console.log('  Route recorded. Re-run with --execute to launch the recommended model.\n');
    return;
  }

  let currentModel = recommendation.model;
  const chain = buildEscalationChain(currentModel);

  for (let index = 0; index < chain.length; index++) {
    const model = index === 0 ? currentModel : getNextModel(currentModel);
    currentModel = model || currentModel;
    const attempt = ledger.createAttempt({
      model: currentModel,
      attemptNumber: index + 1,
      trigger: index === 0 ? 'initial' : 'validation-failed',
    });
    ledger.appendAttempt(run, attempt);

    const execution = executePrintMode(currentModel, task, cwd, classification);
    const validation = validateResult(classification, execution);
    ledger.recordAttemptResult(run, index, {
      ...execution,
      validation,
    });

    if (validation.ok) {
      ledger.finishRun(run, {
        status: 'completed',
        outcome: 'success',
        finalModel: currentModel,
        validation,
      });
      console.log(formatRunSummary(run));
      process.stdout.write(execution.output);
      if (!String(execution.output).endsWith('\n')) console.log();
      return;
    }

    if (validation.infrastructureFailure) {
      break;
    }
  }

  ledger.finishRun(run, {
    status: 'completed',
    outcome: 'failed',
    finalModel: currentModel,
    validation: run.attempts.at(-1)?.validation || null,
  });
  console.log(formatRunSummary(run));
  console.error('  All routed attempts failed validation.\n');
}

module.exports = {
  runTaskCommand,
};
