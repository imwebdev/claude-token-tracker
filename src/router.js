/**
 * Task classifier and model router.
 * Analyzes task descriptions and recommends the optimal Claude model tier.
 */

const { applyCustomRules } = require('./rules');

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

  // Check custom rules FIRST -- they take precedence over keyword classification
  try {
    const customMatch = applyCustomRules(task);
    if (customMatch) {
      const resolvedFamily = Object.values(TASK_FAMILIES).includes(customMatch.family)
        ? customMatch.family
        : TASK_FAMILIES.UNKNOWN;
      return {
        family: resolvedFamily,
        complexity,
        confidence: 1.0,
        reasons: [customMatch.reason],
        customModel: customMatch.model || undefined,
      };
    }
  } catch {
    // Rules module unavailable -- fall through to default classification
  }

  // Check for complexity modifiers first
  const isComplex = matchesAny(text, PATTERNS.complex);
  const isSimple = matchesAny(text, PATTERNS.simple);

  // Score each family by number of pattern matches -- highest wins
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

  // Classify by primary intent -- check actionable intents first
  if (matchesAny(text, PATTERNS.architecture)) {
    family = TASK_FAMILIES.ARCHITECTURE;
    complexity = 'high';
    confidence = 0.85;
    reasons.push('architectural decision -- needs deep reasoning');
  } else if (scores.debug >= 1 && scores.edit >= 1) {
    family = TASK_FAMILIES.DEBUG;
    complexity = isComplex ? 'high' : isSimple ? 'low' : 'medium';
    confidence = 0.8;
    reasons.push('debugging task -- needs reasoning + code changes');
  } else if (scores.debug >= 1) {
    family = TASK_FAMILIES.DEBUG;
    complexity = isComplex ? 'high' : isSimple ? 'low' : 'medium';
    confidence = 0.7;
    reasons.push('investigation/debug task -- diagnostic reasoning');
  } else if (scores.edit >= 1 || scores.command >= 1) {
    // Edit/build/command tasks take priority over search when both match
    if (isComplex || scores.edit >= 2 || (scores.command >= 1 && isComplex)) {
      family = TASK_FAMILIES.MULTI_FILE;
      complexity = 'high';
      confidence = 0.75;
      reasons.push('multi-file implementation -- complex changes');
    } else if (scores.command >= 1 && scores.edit === 0) {
      family = TASK_FAMILIES.COMMAND;
      complexity = matchesAny(text, ['deploy', 'migrate', 'production']) ? 'high' : 'low';
      confidence = 0.7;
      reasons.push('command execution');
    } else {
      family = TASK_FAMILIES.CODE_EDIT;
      complexity = isSimple ? 'low' : 'medium';
      confidence = 0.7;
      reasons.push('code edit -- bounded changes');
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
    reasons.push('discovery/search task -- read-only');
  } else if (scores.question >= 1) {
    family = TASK_FAMILIES.QUESTION;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.8;
    reasons.push('question -- informational, no code changes');
  }

  // Short prompts are usually simple -- but only for read-only/question tasks
  // "Fix the critical auth bypass" is 5 words but not low complexity
  const readOnlyFamilies = [TASK_FAMILIES.SEARCH_READ, TASK_FAMILIES.QUESTION, TASK_FAMILIES.COMMAND];
  if (words.length < 8 && complexity !== 'high' && readOnlyFamilies.includes(family)) {
    complexity = 'low';
    if (!reasons.length) reasons.push('short prompt -- likely simple task');
  }

  // Long prompts with lots of context are usually complex
  if (words.length > 50) {
    if (complexity === 'low') complexity = 'medium';
    reasons.push('detailed prompt -- increased complexity');
  }

  return { family, complexity, confidence, reasons };
}

/**
 * Routing preference tiers.
 * preference 0-25:  "max savings" -- push everything possible to haiku
 * preference 26-50: "cost-conscious" (default 35) -- sonnet-heavy, opus only for architecture/multi-file
 * preference 51-75: "balanced" -- opus for complex tasks
 * preference 76-100: "max quality" -- opus for anything medium+
 */

/**
 * Get the base model recommendation (before preference adjustment).
 * Returns { model, reason } for each family×complexity.
 */
function getBaseRecommendation(family, complexity) {
  switch (family) {
    case TASK_FAMILIES.SEARCH_READ:
    case TASK_FAMILIES.QUESTION:
      if (complexity === 'high') return { model: 'sonnet', reason: 'complex search/question needs sonnet reasoning' };
      return { model: 'haiku', reason: 'simple lookup -- haiku is 15x cheaper than opus' };

    case TASK_FAMILIES.REVIEW:
      if (complexity === 'high') return { model: 'opus', reason: 'comprehensive review needs opus depth' };
      return { model: 'sonnet', reason: 'bounded review -- sonnet handles well at 5x less cost' };

    case TASK_FAMILIES.PLAN:
      if (complexity === 'high') return { model: 'opus', reason: 'complex planning needs opus architectural reasoning' };
      return { model: 'sonnet', reason: 'straightforward planning -- sonnet sufficient' };

    case TASK_FAMILIES.ARCHITECTURE:
      return { model: 'opus', reason: 'architectural decisions require deepest reasoning' };

    case TASK_FAMILIES.CODE_EDIT:
      return { model: 'sonnet', reason: 'code edit -- sonnet at 5x less cost' };

    case TASK_FAMILIES.MULTI_FILE:
      return { model: 'opus', reason: 'multi-file changes need opus for cross-file reasoning' };

    case TASK_FAMILIES.DEBUG:
      if (complexity === 'low') return { model: 'sonnet', reason: 'simple bug -- sonnet can handle' };
      if (complexity === 'medium') return { model: 'opus', reason: 'debugging needs opus reasoning to trace root cause' };
      return { model: 'opus', reason: 'complex debugging needs opus' };

    case TASK_FAMILIES.COMMAND:
      if (complexity === 'high') return { model: 'opus', reason: 'high-stakes command (deploy/migrate) needs opus care' };
      return { model: 'sonnet', reason: 'routine command -- sonnet sufficient' };

    default:
      return { model: 'sonnet', reason: 'unknown task type -- defaulting to sonnet (safe middle ground)' };
  }
}

const MODEL_ORDER = ['haiku', 'sonnet', 'opus'];

function downgrade(model) {
  const idx = MODEL_ORDER.indexOf(model);
  return idx > 0 ? MODEL_ORDER[idx - 1] : model;
}

function upgrade(model) {
  const idx = MODEL_ORDER.indexOf(model);
  return idx < MODEL_ORDER.length - 1 ? MODEL_ORDER[idx + 1] : model;
}

// Families where opus is the floor -- never downgrade below opus
const OPUS_FLOOR = new Set([TASK_FAMILIES.ARCHITECTURE]);

/**
 * Recommend the optimal model tier based on classification and user preference.
 * @param {object} classification -- from classifyTask()
 * @param {object} opts -- { preference?: number (0-100) }
 */
function recommendModel(classification, opts = {}) {
  const { family, complexity, customModel } = classification || {};
  let preference = opts.preference;

  // Load from config if not passed explicitly
  if (preference == null) {
    try {
      const config = require('./config');
      preference = config.read().routing_preference;
    } catch {
      preference = 35; // default: sonnet-heavy
    }
  }

  // If a custom rule supplied an explicit model override, honour it directly
  if (customModel && MODEL_ORDER.includes(customModel)) {
    return {
      model: customModel,
      preference,
      fallbackChain: customModel === 'haiku' ? ['haiku', 'sonnet', 'opus']
        : customModel === 'sonnet' ? ['sonnet', 'opus']
        : ['opus'],
      reasons: classification.reasons || [`[custom] model override -> ${customModel}`],
      costMultiplier: customModel === 'haiku' ? 1 : customModel === 'sonnet' ? 3 : 15,
    };
  }

  // ── Smart model selection: use user-defined capabilities if models.json exists ──
  let base;
  try {
    const { selectByCapability } = require('./models');
    const smart = selectByCapability(family, complexity);
    if (smart) {
      base = { model: smart.model, reason: smart.reason };
    }
  } catch {}
  if (!base) base = getBaseRecommendation(family, complexity);

  let model = base.model;
  const reasons = [base.reason];

  // ── A/B experiment override: if an experiment is running for this family, use its assigned model ──
  try {
    const { getActiveExperiment, assignModel } = require('./experiments');
    const exp = getActiveExperiment(family);
    if (exp) {
      const experimentModel = assignModel(exp);
      if (experimentModel) {
        model = experimentModel;
        reasons.push(`[experiment] ${exp.id} (${exp.family}) -- assigned ${experimentModel} (${exp.count + 1}/${exp.target})`);
        // Skip preference and learning adjustments when experiment is active
        return {
          model,
          preference,
          fallbackChain: model === 'haiku' ? ['haiku', 'sonnet', 'opus']
            : model === 'sonnet' ? ['sonnet', 'opus']
            : ['opus'],
          reasons,
          costMultiplier: model === 'haiku' ? 1 : model === 'sonnet' ? 3 : 15,
          experiment: { id: exp.id, family: exp.family },
        };
      }
    }
  } catch {
    // Experiments module not available -- skip
  }

  // Apply preference adjustment
  if (preference <= 25 && !OPUS_FLOOR.has(family)) {
    // Max savings: downgrade opus->sonnet, sonnet->haiku where safe
    if (model === 'opus') {
      model = 'sonnet';
      reasons.push(`preference ${preference}/100 (max savings) -- downgraded from opus`);
    } else if (model === 'sonnet' && complexity === 'low') {
      model = 'haiku';
      reasons.push(`preference ${preference}/100 (max savings) -- downgraded from sonnet`);
    }
  } else if (preference <= 50 && !OPUS_FLOOR.has(family)) {
    // Cost-conscious (default): downgrade opus->sonnet for medium-complexity
    if (model === 'opus' && complexity !== 'high') {
      model = 'sonnet';
      reasons.push(`preference ${preference}/100 (cost-conscious) -- sonnet sufficient for medium ${family}`);
    } else if (model === 'opus' && complexity === 'high' && family === TASK_FAMILIES.DEBUG) {
      // Even high-complexity debug can be sonnet at low preference
      model = 'sonnet';
      reasons.push(`preference ${preference}/100 (cost-conscious) -- trying sonnet for debug first`);
    }
  } else if (preference >= 76) {
    // Max quality: upgrade sonnet->opus for medium+ complexity
    if (model === 'sonnet' && complexity !== 'low') {
      model = 'opus';
      reasons.push(`preference ${preference}/100 (max quality) -- upgraded to opus for ${complexity} ${family}`);
    }
  }
  // 51-75: balanced -- use base recommendation as-is

  // ── Adaptive learning: adjust based on historical success rates ──
  if (!OPUS_FLOOR.has(family)) {
    try {
      const { getAdjustment } = require('./learner');
      const adj = getAdjustment(family, model);
      if (adj) {
        if (adj.suggestion === 'upgrade' && adj.upgradeTo) {
          model = adj.upgradeTo;
          reasons.push(`[learned] ${adj.reason}`);
        } else if (adj.suggestion === 'downgrade' && adj.downgradeTo && preference <= 50) {
          // Only apply downgrades when user preference is cost-conscious
          model = adj.downgradeTo;
          reasons.push(`[learned] ${adj.reason}`);
        }
        // 'confirm' -- no change, but we could log it
      }
    } catch {
      // Learner not available -- skip
    }
  }

  return {
    model,
    preference,
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
