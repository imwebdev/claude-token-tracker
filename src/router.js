const TASK_FAMILIES = {
  SEARCH_READ: 'search_read',
  CODE_EDIT: 'code_edit',
  DEBUG: 'debug',
  REVIEW: 'review',
  PLAN: 'plan',
  COMMAND: 'command',
  UNKNOWN: 'unknown',
};

function includesAny(text, patterns) {
  return patterns.some(pattern => text.includes(pattern));
}

function classifyTask(task = '') {
  const text = String(task).trim().toLowerCase();
  const reasons = [];
  let family = TASK_FAMILIES.UNKNOWN;
  let complexity = 'medium';
  let confidence = 0.45;

  if (includesAny(text, ['search', 'find', 'grep', 'look up', 'scan', 'inspect schema', 'trace'])) {
    family = TASK_FAMILIES.SEARCH_READ;
    complexity = includesAny(text, ['entire', 'all files', 'whole codebase']) ? 'medium' : 'low';
    confidence = 0.8;
    reasons.push('discovery-oriented keywords');
  } else if (includesAny(text, ['review', 'audit', 'compare', 'benchmark'])) {
    family = TASK_FAMILIES.REVIEW;
    complexity = includesAny(text, ['entire', 'full', 'comprehensive']) ? 'high' : 'medium';
    confidence = 0.75;
    reasons.push('review-oriented keywords');
  } else if (includesAny(text, ['plan', 'design', 'architecture', 'spec'])) {
    family = TASK_FAMILIES.PLAN;
    complexity = includesAny(text, ['system', 'platform', 'across projects']) ? 'high' : 'medium';
    confidence = 0.72;
    reasons.push('planning-oriented keywords');
  } else if (includesAny(text, ['fix', 'edit', 'update', 'change', 'implement', 'refactor', 'write code'])) {
    family = includesAny(text, ['bug', 'broken', 'debug', 'why does', 'failure', 'regression'])
      ? TASK_FAMILIES.DEBUG
      : TASK_FAMILIES.CODE_EDIT;
    complexity = includesAny(text, ['multi-file', 'across', 'full app', 'architecture']) ? 'high' : 'medium';
    confidence = 0.7;
    reasons.push('implementation-oriented keywords');
  } else if (includesAny(text, ['run ', 'execute ', 'command', 'deploy', 'build', 'test'])) {
    family = TASK_FAMILIES.COMMAND;
    complexity = includesAny(text, ['deploy', 'migration', 'production']) ? 'high' : 'medium';
    confidence = 0.65;
    reasons.push('command-execution keywords');
  }

  if (text.split(/\s+/).length < 6 && confidence < 0.8) {
    complexity = complexity === 'high' ? 'high' : 'low';
    reasons.push('short prompt, low context');
  }

  return { family, complexity, confidence, reasons };
}

function recommendModel(classification) {
  const { family, complexity } = classification || {};
  let model = 'sonnet';
  const reasons = [];

  if (family === TASK_FAMILIES.SEARCH_READ && complexity !== 'high') {
    model = 'haiku';
    reasons.push('cheap discovery task');
  } else if (family === TASK_FAMILIES.REVIEW || family === TASK_FAMILIES.CODE_EDIT) {
    model = complexity === 'high' ? 'opus' : 'sonnet';
    reasons.push('bounded code quality task');
  } else if (family === TASK_FAMILIES.DEBUG || family === TASK_FAMILIES.PLAN) {
    model = complexity === 'low' ? 'sonnet' : 'opus';
    reasons.push('higher reasoning demand');
  } else if (family === TASK_FAMILIES.COMMAND) {
    model = complexity === 'high' ? 'opus' : 'sonnet';
    reasons.push('command execution needs reliable synthesis');
  } else {
    reasons.push('safe default');
  }

  return {
    model,
    fallbackChain: model === 'haiku' ? ['haiku', 'sonnet', 'opus']
      : model === 'sonnet' ? ['sonnet', 'opus']
      : ['opus'],
    reasons,
  };
}

function expectedExecutionMode(classification) {
  if (!classification) return 'route-only';
  if (classification.family === TASK_FAMILIES.UNKNOWN) {
    return 'route-only';
  }
  if ([
    TASK_FAMILIES.SEARCH_READ,
    TASK_FAMILIES.REVIEW,
    TASK_FAMILIES.PLAN,
    TASK_FAMILIES.CODE_EDIT,
    TASK_FAMILIES.DEBUG,
    TASK_FAMILIES.COMMAND,
  ].includes(classification.family)) {
    return 'print';
  }
  return 'route-only';
}

module.exports = {
  TASK_FAMILIES,
  classifyTask,
  expectedExecutionMode,
  recommendModel,
};
