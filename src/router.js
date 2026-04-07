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
  search: [
    'search', 'find', 'grep', 'look up', 'scan', 'where is', 'which file',
    'locate', 'list', 'show me', 'what is', 'read', 'check', 'inspect',
    'explore', 'browse', 'reference', 'references',
    'look at',                 // "look at the error log"
    'where is the', 'where are the', // boost search score vs question "is the" overlap
  ],
  question: [
    // Classic interrogatives
    'how do', 'how does', 'how is', 'how are', 'how would',
    'what does', 'what is the', 'what will', 'what would', 'what do you', 'what are',
    'why does', 'why is', 'why are', 'why would',
    'where do', 'where are', 'where is',
    'when should', 'when do', 'when is',
    'should we', 'should i', 'do we', 'do you', 'do i',
    'are we', 'is this', 'is that', 'is there',
    // Natural English opinion/conversational
    'can you', 'could you', 'would you', 'will you', 'will this',
    'can you explain', 'tell me', 'help me understand',
    'any thoughts', 'thoughts on', 'what do you think',
    'does this', 'does that', 'how many', 'is there a', 'is the',
    'summarize', 'describe', 'explain',
    // Does-X patterns: "does the learner track...", "does it update..."
    'does the', 'does it', 'does my',
    // Curiosity and wondering
    'wondering', 'curious', 'i wonder',
    'any idea', 'any reason', 'any chance',
    'just checking', 'just wondering', 'quick question',
    'out of curiosity', 'is it possible', 'is it safe', 'is it ok',
    'remind me',
    // Specific conceptual questions (more specific than bare "what is" → beat search in score)
    'what is the difference', 'what is the best', 'what is the purpose', 'what is the reason',
    // Additional natural question forms
    'any way to', 'is there any way',   // "any way to override X" = question
    'not sure',                          // "not sure I understand" = explanation request
    'anyone know', 'does anyone',        // "anyone know if X" = community question
    'was that', 'was it',               // "was that always the case" = history question
  ],
  review: [
    'review', 'audit', 'compare', 'benchmark', 'analyze', 'assess',
    'evaluate', 'check quality', 'code review', 'look over',
    // Informal review requests
    'take a look', 'quick look', 'have a look', 'take a peek',
    'once over', 'once-over', 'sanity check',
    'does this look', 'anything jump',
    'second opinion', 'second pair',
    'mind giving', 'mind reviewing',
    'right track', 'on track',    // "am I on the right track" = validation request
    'make sense',                  // "does the flow still make sense" = review
    'am i',                        // "am I doing this right" = validation request
  ],
  plan: [
    'plan', 'design', 'spec', 'roadmap', 'outline', 'strategy', 'approach',
    'how should', 'what approach', 'propose',
    // Collaborative planning language
    "let's", 'lets', 'map out', 'figure out', 'think through',
    'brainstorm', 'rethink', 'we should',
  ],
  architecture: ['architecture', 'system design', 'infrastructure', 'database schema', 'data model', 'migration strategy', 'scalability'],
  edit: ['fix', 'edit', 'update', 'change', 'modify', 'implement', 'refactor', 'write', 'rewrite', 'create', 'add', 'remove', 'delete', 'rename', 'move', 'replace', 'make', 'overhaul'],
  debug: [
    // Classic keywords (removed 'issue' — too ambiguous with GitHub issues)
    'bug', 'broken', 'debug', 'failure', 'regression', 'not working', 'fails', 'wrong', 'problem', 'unexpected',
    // Inflected forms (word boundary blocks suffix matching)
    'crash', 'crashes', 'crashing',
    // Natural language symptom descriptions
    'not updating', 'not appearing', 'not firing', 'not fire', 'not showing', 'not loading',
    'not clearing', 'not triggering', 'not triggered', 'not running', 'not saving',
    // Still/keeps/never patterns
    'keeps', 'still not', 'still showing', 'still getting', 'still going', 'still routing',
    'never fires', 'never reaches', 'never reached', 'never called', 'never triggered',
    // Contractions — both apostrophe and plain forms
    "isn't", 'isnt', "doesn't", 'doesnt', "didn't", 'didnt', "won't", 'wont',
    "don't", 'dont',                   // "don't match", "don't seem to be applied"
    "haven't", 'havent',               // "haven't changed in days"
    "aren't", 'arent',                 // "aren't firing"
    // Behavioral anomaly indicators
    // NOTE: "instead of" removed — "thoughts on X instead of Y" is a question, not a bug.
    // Cases like "still routing to sonnet" are covered by "still routing"/"still going" patterns.
    'stopped', 'hangs', 'stuck',
    'resets',                           // "session cost resets mid-conversation"
    'duplicate', 'duplicates',          // "I see duplicate entries"
    'broke', 'breaks',                  // "the dashboard broke"
    'garbled', 'truncated', 'chokes',   // output corruption, data loss, process failure
    'blank', 'nothing is', 'nothing shows', 'nothing works',
    'keep getting',                     // "I keep getting routed to..." (first-person recurring)
    'still choosing', 'still running',  // stuck/unexpected persistence (adds to existing still-*)
    'no matter what', 'regardless',    // "no matter what I type" = stuck behavior
    'used to work', 'used to',          // "this used to work" = regression
    'sometimes',                        // intermittent: "sometimes the hook fires twice"
    // Return value failures
    'returns null', 'returns undefined', 'returns false',
    // Specific diagnostic indicators
    'dead code', 'unreachable', 'NaN',
    'way off', 'off by',
    // Context/contrast words (weak)
    'despite', 'even though', 'even when',
    "don't know why", 'dont know why', 'not sure why',
    'seems to not', 'appears to not',
    'every single', 'every time',   // "fires every single prompt" = repeating bug
    'issue is',                      // "the issue is that X" = problem description
  ],
  command: ['run', 'execute', 'deploy', 'build', 'test', 'install', 'start', 'stop', 'restart', 'migrate', 'merge', 'push', 'pull'],
  complex: ['multi-file', 'across', 'full app', 'entire', 'all files', 'whole codebase', 'whole', 'comprehensive', 'complete', 'overhaul', 'rewrite', 'from scratch', 'system-wide', 'system wide'],
  simple: ['typo', 'rename', 'one line', 'small', 'quick', 'simple', 'just', 'only'],
};

// Opinion-seeking questions override plan/review/edit (the user wants your view, not action).
const OPINION_QUESTION_PATTERNS = [
  'what do you think', 'do you think',
  'what would you recommend', 'what would you',
  'what would happen',
  'wondering', 'curious',            // "wondering if we need..." = curiosity, not planning
  'just checking', 'just wondering', // "just checking if this is right" = validation question
  'out of curiosity',                // "out of curiosity does X do Y" = curiosity question
];

// Info-seeking interrogatives override edit/command but NOT plan/review.
// "how do I change X" = asking for instructions, not requesting a change.
// "should we merge" = asking for a recommendation, not issuing the command.
const INFO_QUESTION_PATTERNS = [
  'how do i', 'how do you',
  'should we', 'should i',
  'can you explain', 'help me understand',
  'does the', 'does it', 'does my',  // "does the hook reset" = asking not commanding
  'is it possible', 'is it safe', 'is it ok',
];

// Short conversational responses that aren't task requests.
const CONVERSATIONAL_PATTERNS = [
  'i like', 'i love', 'i agree', 'looks good', 'sounds good',
  'that sounds', 'that looks', 'great idea', 'good idea', 'makes sense',
];

// Strong debug signals used for the debug+edit branch.
// "instead of", "despite", etc. are "weak" debug — valid for debug-only (no competing edit)
// but not strong enough to override a clear code-edit action.
const STRONG_DEBUG_SIGNALS = [
  'bug', 'broken', 'debug', 'failure', 'regression', 'not working', 'fails', 'wrong',
  'problem', 'unexpected',
  'crash', 'crashes', 'crashing',
  'not updating', 'not appearing', 'not firing', 'not fire', 'not showing', 'not loading',
  'not clearing', 'not triggering', 'not triggered', 'not running', 'not saving',
  'keeps', 'keep getting',
  'still not', 'still showing', 'still getting', 'still going', 'still routing', 'still choosing', 'still running',
  'never fires', 'never reaches', 'never reached', 'never called', 'never triggered',
  "isn't", 'isnt', "doesn't", 'doesnt', "didn't", 'didnt', "won't", 'wont',
  "don't", 'dont', "haven't", 'havent', "aren't", 'arent',
  'stopped', 'hangs', 'stuck',
  'resets', 'duplicate', 'duplicates', 'broke', 'breaks',
  'garbled', 'truncated', 'chokes',
  'blank', 'nothing is', 'nothing shows', 'nothing works',
  'no matter what', 'regardless',
  'used to work',
  'returns null', 'returns undefined', 'returns false',
  'dead code', 'unreachable', 'NaN',
  'way off', 'off by',
  'seems to not', 'appears to not',
  'every single', 'every time',
  'issue is',
  "don't know why", 'dont know why', 'not sure why',
];

// Primary edit actions — strong enough to override a review signal.
// "delete the X" or "implement the X" are unambiguously code changes, not reviews.
const PRIMARY_EDIT_ACTIONS = ['delete', 'remove', 'create', 'implement', 'rewrite'];

// Primary command verbs — strong enough to override a review signal.
const PRIMARY_COMMAND_VERBS = ['execute', 'deploy', 'migrate'];

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

  // Pre-computed helpers for the priority chain
  const strongDebugScore = countMatches(text, STRONG_DEBUG_SIGNALS);
  const isOpinionQuestion = matchesAny(text, OPINION_QUESTION_PATTERNS);
  const isInfoQuestion = matchesAny(text, INFO_QUESTION_PATTERNS);
  // Conversational affirmations ("i like this", "looks good") with no real task
  const isConversational = matchesAny(text, CONVERSATIONAL_PATTERNS) && words.length <= 8;
  // Primary edit/command actions that override a review signal
  const hasPrimaryEdit = matchesAny(text, PRIMARY_EDIT_ACTIONS);
  const hasPrimaryCommand = matchesAny(text, PRIMARY_COMMAND_VERBS);

  // ── Priority chain ──────────────────────────────────────────────────────────
  // Order matters: first matching branch wins.

  if (isConversational) {
    // "i like this", "looks good" — conversational, not a task
    family = TASK_FAMILIES.UNKNOWN;
    confidence = 0.5;
    reasons.push('conversational affirmation -- no task');
  } else if (isOpinionQuestion && !matchesAny(text, PATTERNS.debug)) {
    // Opinion-seeking questions beat EVERYTHING (including architecture) unless there's
    // a debug signal. "what do you think about this architecture" = question, not arch.
    // "do you think the bug is in learner.js" = question (debug context handled below).
    family = TASK_FAMILIES.QUESTION;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.85;
    reasons.push('question -- opinion-seeking');
  } else if (matchesAny(text, PATTERNS.architecture)) {
    family = TASK_FAMILIES.ARCHITECTURE;
    complexity = 'high';
    confidence = 0.85;
    reasons.push('architectural decision -- needs deep reasoning');
  } else if (strongDebugScore >= 1 && scores.edit >= 1) {
    // Strong debug signal + edit action = debug+edit (e.g. "fix the bug", "fix dead code")
    // Weak debug signals like "instead of"/"despite" don't trigger this branch,
    // preventing "change X instead of Y" from being misrouted as debug.
    family = TASK_FAMILIES.DEBUG;
    complexity = isComplex ? 'high' : isSimple ? 'low' : 'medium';
    confidence = 0.8;
    reasons.push('debugging task -- needs reasoning + code changes');
  } else if (scores.debug >= 1 && scores.edit === 0) {
    // Debug signal with no competing edit action (e.g. "the hook isn't firing")
    family = TASK_FAMILIES.DEBUG;
    complexity = isComplex ? 'high' : isSimple ? 'low' : 'medium';
    confidence = 0.7;
    reasons.push('investigation/debug task -- diagnostic reasoning');
  } else if (scores.plan >= 1) {
    // Plan before edit/command: "design X" / "let's figure out" / "what approach should we"
    // are planning tasks even when action words (build, test) appear as context.
    family = TASK_FAMILIES.PLAN;
    complexity = isComplex ? 'high' : 'medium';
    confidence = 0.72;
    reasons.push('planning/design task');
  } else if (scores.review >= 1 && !hasPrimaryEdit && !hasPrimaryCommand) {
    // Review before edit/command: "look over X before merging" is still a review.
    // Exception: hasPrimaryEdit ("delete", "implement") or hasPrimaryCommand ("execute", "deploy")
    // means the edit/command IS the primary intent.
    family = TASK_FAMILIES.REVIEW;
    complexity = isComplex ? 'high' : 'medium';
    confidence = 0.75;
    reasons.push('code review/audit task');
  } else if (isInfoQuestion) {
    // Info-seeking interrogatives ("how do I", "should we") beat edit/command
    // but lose to plan/review so "what approach should we take" stays as plan.
    family = TASK_FAMILIES.QUESTION;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.82;
    reasons.push('question -- info-seeking interrogative');
  } else if (scores.edit >= 1 || scores.command >= 1) {
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
  } else if (scores.search >= 1) {
    // Question beats search when question scores higher (more specific match).
    // e.g. "what is the difference between X and Y": question=2 (what is the, what is the difference)
    // vs search=1 (what is) → question wins.
    if (scores.question > scores.search) {
      family = TASK_FAMILIES.QUESTION;
      complexity = isComplex ? 'medium' : 'low';
      confidence = 0.78;
      reasons.push('question -- outscored search signals');
    } else {
      family = TASK_FAMILIES.SEARCH_READ;
      complexity = isComplex ? 'medium' : 'low';
      confidence = 0.85;
      reasons.push('discovery/search task -- read-only');
    }
  } else if (scores.question >= 1) {
    family = TASK_FAMILIES.QUESTION;
    complexity = isComplex ? 'medium' : 'low';
    confidence = 0.8;
    reasons.push('question -- informational, no code changes');
  }

  // Short prompts are usually simple -- but only for read-only/question/unknown tasks
  // "Fix the critical auth bypass" is 5 words but not low complexity
  const readOnlyFamilies = [TASK_FAMILIES.SEARCH_READ, TASK_FAMILIES.QUESTION, TASK_FAMILIES.COMMAND, TASK_FAMILIES.UNKNOWN];
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
 * Get the base model recommendation (before floor adjustment).
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
 * Recommend the optimal model tier based on classification and model floor.
 *
 * Default model behaviour (routing starts here, goes up or down based on complexity):
 *   'haiku'  — start on haiku, upgrade when the task genuinely needs more
 *   'sonnet' — start on sonnet (default), haiku for simple tasks, opus for complex
 *   'opus'   — everything runs on opus, no downgrading
 *
 * @param {object} classification -- from classifyTask()
 * @param {object} opts -- { default_model?: string, model_floor?: string (legacy), preference?: number (legacy) }
 */
function recommendModel(classification, opts = {}) {
  const { family, complexity, customModel } = classification || {};

  // Resolve default model from opts or config
  let floor = opts.default_model || opts.model_floor; // accept both; model_floor is legacy
  let preference = opts.preference; // legacy compat
  if (!floor) {
    try {
      const config = require('./config');
      const cfg = config.read();
      floor = cfg.default_model || cfg.model_floor;
      if (preference == null) preference = cfg.routing_preference;
    } catch {}
  }
  if (!MODEL_ORDER.includes(floor)) floor = 'sonnet';
  if (preference == null) preference = 35;

  // If a custom rule supplied an explicit model override, honour it directly
  if (customModel && MODEL_ORDER.includes(customModel)) {
    return {
      model: customModel,
      default_model: floor,
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

  // ── A/B experiment override ──
  try {
    const { getActiveExperiment, assignModel } = require('./experiments');
    const exp = getActiveExperiment(family);
    if (exp) {
      const experimentModel = assignModel(exp);
      if (experimentModel) {
        model = experimentModel;
        reasons.push(`[experiment] ${exp.id} (${exp.family}) -- assigned ${experimentModel} (${exp.count + 1}/${exp.target})`);
        return {
          model,
          default_model: floor,
          fallbackChain: model === 'haiku' ? ['haiku', 'sonnet', 'opus']
            : model === 'sonnet' ? ['sonnet', 'opus']
            : ['opus'],
          reasons,
          costMultiplier: model === 'haiku' ? 1 : model === 'sonnet' ? 3 : 15,
          experiment: { id: exp.id, family: exp.family },
        };
      }
    }
  } catch {}

  // ── Apply model floor ──
  const floorIdx = MODEL_ORDER.indexOf(floor);
  const modelIdx = MODEL_ORDER.indexOf(model);

  if (floor === 'opus') {
    // Opus-first: everything runs on opus, no routing
    if (model !== 'opus') {
      reasons.push(`floor=opus -- upgraded from ${model}`);
      model = 'opus';
    }
  } else if (floor === 'haiku') {
    // Haiku-first: start on haiku, only upgrade when task genuinely needs more
    if (!OPUS_FLOOR.has(family)) {
      if (model === 'opus' && complexity !== 'high') {
        model = 'sonnet';
        reasons.push('floor=haiku -- downgraded opus to sonnet (not high complexity)');
      }
      if (model === 'opus' && complexity === 'high' && family === TASK_FAMILIES.DEBUG) {
        model = 'sonnet';
        reasons.push('floor=haiku -- trying sonnet for debug first');
      }
      if (model === 'sonnet' && complexity === 'low') {
        model = 'haiku';
        reasons.push('floor=haiku -- downgraded to haiku (low complexity)');
      }
      // Unknown family: we have no reason to pay for sonnet when we can't classify the task
      if (model === 'sonnet' && family === TASK_FAMILIES.UNKNOWN) {
        model = 'haiku';
        reasons.push('floor=haiku -- unclassified task, defaulting to haiku');
      }
      // Medium sonnet tasks that are code edits/reviews/plans stay on sonnet — they need it
      // Everything else at medium goes to haiku
      const keepSonnet = new Set([TASK_FAMILIES.CODE_EDIT, TASK_FAMILIES.REVIEW, TASK_FAMILIES.PLAN, TASK_FAMILIES.MULTI_FILE, TASK_FAMILIES.DEBUG]);
      if (model === 'sonnet' && complexity === 'medium' && !keepSonnet.has(family)) {
        model = 'haiku';
        reasons.push(`floor=haiku -- ${family} at medium complexity, haiku sufficient`);
      }
    }
  } else {
    // Sonnet-first (default): downgrade opus for non-high-complexity
    if (!OPUS_FLOOR.has(family)) {
      if (model === 'opus' && complexity !== 'high') {
        model = 'sonnet';
        reasons.push(`floor=sonnet -- sonnet sufficient for ${complexity} ${family}`);
      }
      if (model === 'opus' && complexity === 'high' && family === TASK_FAMILIES.DEBUG) {
        model = 'sonnet';
        reasons.push('floor=sonnet -- trying sonnet for debug first');
      }
    }
  }

  // ── Adaptive learning: adjust based on historical success rates ──
  if (!OPUS_FLOOR.has(family) && floor !== 'opus') {
    try {
      const { getAdjustment } = require('./learner');
      const adj = getAdjustment(family, model);
      if (adj) {
        if (adj.suggestion === 'upgrade' && adj.upgradeTo) {
          model = adj.upgradeTo;
          reasons.push(`[learned] ${adj.reason}`);
        } else if (adj.suggestion === 'downgrade' && adj.downgradeTo) {
          const downgradeIdx = MODEL_ORDER.indexOf(adj.downgradeTo);
          if (downgradeIdx >= floorIdx) {
            // Downgrade is within the allowed floor — apply it
            model = adj.downgradeTo;
            reasons.push(`[learned] ${adj.reason}`);
          } else {
            // Downgrade blocked by model floor — surface as a tip so user can see the insight
            reasons.push(`[learned:tip] ${adj.reason} (floor=${floor} prevents downgrade to ${adj.downgradeTo})`);
          }
        } else if (adj.suggestion === 'confirm') {
          reasons.push(`[learned:confirm] ${adj.reason}`);
        }
      }
    } catch {}
  }

  return {
    model,
    baseModel: base.model,
    default_model: floor,
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
