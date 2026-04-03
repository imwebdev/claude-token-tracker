/**
 * Task classifier and model router.
 * Analyzes task descriptions and recommends the optimal Claude model tier.
 */

const TASK_FAMILIES = {
  SEARCH_READ: 'search_read',
  CODE_EDIT: 'code_edit',
  MULTI_FILE: 'multi_file',
  DEBUG: 'debug',
  REVIEW: 'review',
  PLAN: 'plan',
  ARCHITECTURE: 'architecture',
  COMMAND: 'command',
  QUESTION: 'question',
  UNKNOWN: 'unknown',
};

const PATTERNS = {
  search: ['search', 'find', 'grep', 'look up', 'scan', 'where is', 'which file', 'locate', 'list', 'show me', 'what is', 'read', 'check', 'inspect', 'explore', 'browse'],
  question: ['how do', 'how does', 'what does', 'why does', 'can you explain', 'tell me', 'what is the', 'does this', 'is there', 'help me understand', 'summarize', 'describe', 'explain'],
  review: ['review', 'audit', 'compare', 'benchmark', 'analyze', 'assess', 'evaluate', 'check quality', 'code review', 'look over'],
  plan: ['plan', 'design', 'spec', 'roadmap', 'outline', 'strategy', 'approach', 'how should', 'what approach', 'propose'],
  architecture: ['architecture', 'system design', 'infrastructure', 'database schema', 'data model', 'migration strategy', 'scalability'],
  edit: ['fix', 'edit', 'update', 'change', 'modify', 'implement', 'refactor', 'write', 'create', 'add', 'remove', 'delete', 'rename', 'move', 'replace'],
  debug: ['bug', 'broken', 'debug', 'why does', 'failure', 'regression', 'error', 'crash', 'not working', 'fails', 'wrong', 'issue', 'problem', 'unexpected'],
  command: ['run', 'execute', 'deploy', 'build', 'test', 'install', 'start', 'stop', 'restart', 'migrate'],
  complex: ['multi-file', 'across', 'full app', 'entire', 'all files', 'whole codebase', 'comprehensive', 'complete', 'overhaul', 'rewrite', 'from scratch', 'system-wide'],
  simple: ['typo', 'rename', 'one line', 'small', 'quick', 'simple', 'just', 'only'],
};

function matchesWord(text, pattern) {
  // Match whole words/phrases, not substrings (e.g. "check" shouldn't match "checkout")
  const re = new RegExp(`(?:^|\\s|[^a-z])${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|[^a-z])`, 'i');
  return re.test(text);
}

function matchesAny(text, patterns) {
  return patterns.some(p => matchesWord(text, p));
}

function countMatches(text, patterns) {
  return patterns.filter(p => matchesWord(text, p)).length;
}

/**
 * Classify a task description into family, complexity, and confidence.
 */
function classifyTask(task = '') {
  const text = String(task).trim().toLowerCase();
  const words = text.split(/\s+/);
  const reasons = [];
  let family = TASK_FAMILIES.UNKNOWN;
  let complexity = 'medium';
  let confidence = 0.4;

  // Check for complexity modifiers first
  const isComplex = matchesAny(text, PATTERNS.complex);
  const isSimple = matchesAny(text, PATTERNS.simple);

  // Score each family by number of pattern matches — highest wins
  const scores = {
    search: countMatches(text, PATTERNS.search),
    question: countMatches(text, PATTERNS.question),
    edit: countMatches(text, PATTERNS.edit),
    debug: countMatches(text, PATTERNS.debug),
    review: countMatches(text, PATTERNS.review),
    plan: countMatches(text, PATTERNS.plan),
    architecture: countMatches(text, PATTERNS.architecture),
    command: countMatches(text, PATTERNS.command),
  };

  // Classify by primary intent — check actionable intents first
  if (matchesAny(text, PATTERNS.architecture)) {
    family = TASK_FAMILIES.ARCHITECTURE;
    complexity = 'high';
    confidence = 0.85;
    reasons.push('architectural decision — needs deep reasoning');
  } else if (scores.debug >= 1 && scores.edit >= 1) {
    family = TASK_FAMILIES.DEBUG;
    complexity = isComplex ? 'high' : isSimple ? 'low' : 'medium';
    confidence = 0.8;
    reasons.push('debugging task — needs reasoning + code changes');
  } else if (scores.edit >= 1 || scores.command >= 1) {
    // Edit/build/command tasks take priority over search when both match
    if (isComplex || scores.edit >= 2 || (scores.command >= 1 && isComplex)) {
      family = TASK_FAMILIES.MULTI_FILE;
      complexity = 'high';
      confidence = 0.75;
      reasons.push('multi-file implementation — complex changes');
    } else if (scores.command >= 1 && scores.edit === 0) {
      family = TASK_FAMILIES.COMMAND;
      complexity = matchesAny(text, ['deploy', 'migrate', 'production']) ? 'high' : 'low';
      confidence = 0.7;
      reasons.push('command execution');
    } else {
      family = TASK_FAMILIES.CODE_EDIT;
      complexity = isSimple ? 'low' : 'medium';
      confidence = 0.7;
      reasons.push('code edit — bounded changes');
    }
  } else if (scores.review >= 1) {
    family = TASK_FAMILIES.REVIEW;
    complexity = isComplex ? 'high' : 'medium';
    confidence = 0.75;
    reasons.push('code review/audit task');
  } else if (scores.plan >= 1) {
    family = TASK_FAMILIES.PLAN;
    complexity = isComplex ? 'high' : 'medium';
    confidence = 0.72;
    reasons.push('planning/design task');
  } else if (scores.search >= 1) {
    family = TASK_FAMILIES.SEARCH_READ;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.85;
    reasons.push('discovery/search task — read-only');
  } else if (scores.question >= 1) {
    family = TASK_FAMILIES.QUESTION;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.8;
    reasons.push('question — informational, no code changes');
  }

  // Short prompts are usually simple
  if (words.length < 8 && complexity !== 'high') {
    complexity = 'low';
    if (!reasons.length) reasons.push('short prompt — likely simple task');
  }

  // Long prompts with lots of context are usually complex
  if (words.length > 50) {
    if (complexity === 'low') complexity = 'medium';
    reasons.push('detailed prompt — increased complexity');
  }

  return { family, complexity, confidence, reasons };
}

/**
 * Recommend the optimal model tier based on classification.
 * Returns model name and justification.
 */
function recommendModel(classification) {
  const { family, complexity } = classification || {};
  let model = 'sonnet';
  const reasons = [];

  switch (family) {
    case TASK_FAMILIES.SEARCH_READ:
    case TASK_FAMILIES.QUESTION:
      if (complexity === 'high') {
        model = 'sonnet';
        reasons.push('complex search/question needs sonnet reasoning');
      } else {
        model = 'haiku';
        reasons.push('simple lookup — haiku is 15x cheaper than opus');
      }
      break;

    case TASK_FAMILIES.REVIEW:
      model = complexity === 'high' ? 'opus' : 'sonnet';
      reasons.push(complexity === 'high'
        ? 'comprehensive review needs opus depth'
        : 'bounded review — sonnet handles well at 5x less cost');
      break;

    case TASK_FAMILIES.PLAN:
      model = complexity === 'high' ? 'opus' : 'sonnet';
      reasons.push(complexity === 'high'
        ? 'complex planning needs opus architectural reasoning'
        : 'straightforward planning — sonnet sufficient');
      break;

    case TASK_FAMILIES.ARCHITECTURE:
      model = 'opus';
      reasons.push('architectural decisions require deepest reasoning');
      break;

    case TASK_FAMILIES.CODE_EDIT:
      if (complexity === 'low') {
        model = 'sonnet';
        reasons.push('simple edit — sonnet handles mechanical changes well');
      } else {
        model = 'sonnet';
        reasons.push('bounded code edit — sonnet at 5x less cost');
      }
      break;

    case TASK_FAMILIES.MULTI_FILE:
      model = 'opus';
      reasons.push('multi-file changes need opus for cross-file reasoning');
      break;

    case TASK_FAMILIES.DEBUG:
      model = complexity === 'low' ? 'sonnet' : 'opus';
      reasons.push(complexity === 'low'
        ? 'simple bug — sonnet can handle'
        : 'debugging needs opus reasoning to trace root cause');
      break;

    case TASK_FAMILIES.COMMAND:
      model = complexity === 'high' ? 'opus' : 'sonnet';
      reasons.push(complexity === 'high'
        ? 'high-stakes command (deploy/migrate) needs opus care'
        : 'routine command — sonnet sufficient');
      break;

    default:
      model = 'sonnet';
      reasons.push('unknown task type — defaulting to sonnet (safe middle ground)');
      break;
  }

  return {
    model,
    fallbackChain: model === 'haiku' ? ['haiku', 'sonnet', 'opus']
      : model === 'sonnet' ? ['sonnet', 'opus']
      : ['opus'],
    reasons,
    costMultiplier: model === 'haiku' ? 1 : model === 'sonnet' ? 3 : 15,
  };
}

module.exports = {
  TASK_FAMILIES,
  classifyTask,
  recommendModel,
};
