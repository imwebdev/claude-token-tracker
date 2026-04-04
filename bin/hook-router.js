#!/usr/bin/env node
/**
 * Token Coach — Unified hook handler for Claude Code.
 *
 * Handles all hook events via a single entry point.
 * Receives JSON on stdin from Claude Code hooks system.
 *
 * Key behaviors:
 * - UserPromptSubmit: Classify prompt, inject routing recommendation
 * - PreToolUse (Agent): Log model routing decisions
 * - SubagentStop: Log what actually ran
 * - SessionStart: Log session model
 * - Stop: Write session summary
 */
const path = require('path');

// Resolve modules relative to package root
const ROOT = path.join(__dirname, '..');
const router = require(path.join(ROOT, 'src', 'router'));
const events = require(path.join(ROOT, 'src', 'events'));

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    // Timeout after 5s in case stdin never closes
    setTimeout(() => resolve({}), 5000);
  });
}

function getProject(input) {
  const cwd = input.cwd || '';
  return path.basename(cwd) || 'unknown';
}

// ─── Event Handlers ───────────────────────────────

function handleSessionStart(input) {
  events.logEvent('session_start', {
    session_id: input.session_id,
    model: input.model || 'unknown',
    project: getProject(input),
    source: input.source,
  });
  // No output needed
  return null;
}

function handleUserPromptSubmit(input) {
  const prompt = input.prompt || '';

  // Skip very short prompts (commands, yes/no answers)
  if (prompt.length < 10) return null;

  const classification = router.classifyTask(prompt);
  const recommendation = router.recommendModel(classification);

  events.logEvent('routing_decision', {
    session_id: input.session_id,
    project: getProject(input),
    prompt_preview: prompt.slice(0, 200),
    classification,
    recommended_model: recommendation.model,
    recommended_reason: recommendation.reasons.join('; '),
    actual_model: null, // filled by PreToolUse or Stop
    was_delegated: null,
  });

  // ── Console output (stderr → visible to user) ──
  const confidence = classification.confidence >= 0.7 ? 'high' : 'moderate';
  const modelColors = { haiku: '\x1b[32m', sonnet: '\x1b[33m', opus: '\x1b[35m' };
  const color = modelColors[recommendation.model] || '\x1b[37m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';

  const action = recommendation.model === 'haiku' ? '↓ REDIRECT to haiku subagent'
    : recommendation.model === 'sonnet' ? '↓ REDIRECT to sonnet subagent'
    : '● Handle directly on opus';

  // Session cost tracking
  const sessionCost = events.getSessionCost(input.session_id);
  const promptCost = events.estimatePromptCost(recommendation.model);
  const totalCost = sessionCost.estimatedCost + promptCost;
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`;
  const promptCount = sessionCost.prompts + 1;
  const costColor = totalCost > 2 ? '\x1b[31m' : totalCost > 0.5 ? '\x1b[33m' : '\x1b[32m';

  // ── Warnings ──
  const warnings = [];
  const yellow = '\x1b[33m';

  // Session length warning (#37)
  if (promptCount >= 20 && promptCount % 5 === 0) {
    warnings.push(`${yellow}⚠ Session has ${promptCount} prompts (${costStr}). Consider /compact or starting fresh.${reset}`);
  }

  // Budget alert (#21)
  try {
    const config = require(path.join(ROOT, 'src', 'config'));
    const cfg = config.read();
    if (cfg.daily_alert && totalCost >= cfg.daily_alert) {
      warnings.push(`${yellow}⚠ Daily spend ~$${totalCost.toFixed(2)} has reached your alert threshold ($${cfg.daily_alert}).${reset}`);
    }
    if (cfg.daily_cap && totalCost >= cfg.daily_cap) {
      warnings.push(`\x1b[31m⛔ Daily cap ($${cfg.daily_cap}) reached. Consider stopping or switching to cheaper models.${reset}`);
    }
  } catch {}

  // Vague/long prompt warning (#38)
  if (prompt.length > 500 && classification.family === 'unknown') {
    warnings.push(`${yellow}⚠ Long prompt (${prompt.length} chars) classified as unknown — vague prompts waste tokens. Be specific: file paths, line numbers, exact changes.${reset}`);
  }

  // Check if learner adjusted the recommendation
  const learned = recommendation.reasons.some(r => r.startsWith('[learned]'));
  const learnLine = learned ? `  ${bold}  Learned:${reset} ${'\x1b[36m'}${recommendation.reasons.filter(r => r.startsWith('[learned]')).map(r => r.replace('[learned] ', '')).join('; ')}${reset}` : null;

  const lines = [
    `${dim}───────────────────────────────────────${reset}`,
    `${bold}⚡ TOKEN COACH${reset}  ${classification.family} ${dim}(${classification.complexity}, ${confidence} conf)${reset}`,
    `${bold}  Model:${reset} ${color}${recommendation.model.toUpperCase()}${reset}  ${dim}${recommendation.reasons.filter(r => !r.startsWith('[learned]')).join('; ')}${reset}`,
    `${bold}  Action:${reset} ${color}${action}${reset}`,
    ...(learnLine ? [learnLine] : []),
    `${bold}  Session:${reset} ${costColor}${costStr}${reset} ${dim}(${promptCount} prompts)${reset}`,
    ...warnings,
    `${dim}───────────────────────────────────────${reset}`,
  ];
  process.stderr.write(lines.join('\n') + '\n');

  // Inject routing guidance as additional context
  const ctx = [
    `[claude-token-tracker] Task classified: ${classification.family} (${classification.complexity} complexity, ${confidence} confidence).`,
    `Recommended model: ${recommendation.model.toUpperCase()}.`,
    `Reason: ${recommendation.reasons.join('; ')}.`,
  ];

  if (recommendation.model === 'haiku') {
    ctx.push('ACTION: Dispatch this to a haiku subagent. Do NOT process directly on opus.');
  } else if (recommendation.model === 'sonnet') {
    ctx.push('ACTION: Dispatch this to a sonnet subagent unless it requires complex reasoning.');
  } else {
    ctx.push('ACTION: Handle directly — this needs opus-level reasoning.');
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ctx.join(' '),
    },
  };
}

function handlePreToolUse(input) {
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName === 'Agent') {
    const model = toolInput.model || 'opus';
    const description = toolInput.description || '';
    const agentType = toolInput.subagent_type || 'general-purpose';
    const prompt = toolInput.prompt || '';

    // Classify the subagent's task
    const classification = router.classifyTask(prompt);
    const recommendation = router.recommendModel(classification);

    const isOptimal = model === recommendation.model;
    const modelTier = model.includes('opus') ? 'opus'
      : model.includes('sonnet') ? 'sonnet'
      : model.includes('haiku') ? 'haiku' : model;

    events.logEvent('subagent_dispatch', {
      session_id: input.session_id,
      project: getProject(input),
      agent_type: agentType,
      model_used: modelTier,
      recommended_model: recommendation.model,
      is_optimal: isOptimal,
      description,
      classification,
      justification: isOptimal
        ? `Correct: ${modelTier} matches recommendation for ${classification.family} (${classification.complexity})`
        : `Suboptimal: used ${modelTier} but ${recommendation.model} recommended for ${classification.family} (${classification.complexity})`,
    });

    // ── Console output for subagent dispatches ──
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const modelColors = { haiku: '\x1b[32m', sonnet: '\x1b[33m', opus: '\x1b[35m' };
    const color = modelColors[modelTier] || '\x1b[37m';
    const arrow = isOptimal ? '✓' : '⚠';
    const arrowColor = isOptimal ? '\x1b[32m' : '\x1b[31m';
    const desc = description.slice(0, 50);
    const statusMsg = isOptimal
      ? `${arrowColor}${arrow}${reset} optimal`
      : `${arrowColor}${arrow}${reset} used ${modelTier} — ${recommendation.model} would suffice`;

    process.stderr.write(
      `${dim}  ↳${reset} ${bold}Subagent${reset} ${color}${modelTier.toUpperCase()}${reset} ${dim}${agentType}${reset} "${desc}" ${statusMsg}\n`
    );

    // If model is more expensive than needed, add context (but don't block)
    if (!isOptimal && modelTier === 'opus' && recommendation.model !== 'opus') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `[TOKEN COACH] This subagent is using ${modelTier} but ${recommendation.model} would suffice for this ${classification.family} task. Consider using model: "${recommendation.model}" next time.`,
        },
      };
    }
  }

  // Log all tool calls for analytics
  if (toolName !== 'Read' && toolName !== 'Glob' && toolName !== 'Grep') {
    events.logEvent('tool_call', {
      session_id: input.session_id,
      project: getProject(input),
      tool: toolName,
      // Don't log full input for privacy — just key fields
      summary: toolName === 'Bash' ? (toolInput.command || '').slice(0, 100)
        : toolName === 'Write' ? `write ${toolInput.file_path || ''}`
        : toolName === 'Edit' ? `edit ${toolInput.file_path || ''}`
        : toolName === 'Agent' ? `agent(${toolInput.model || 'opus'}) ${(toolInput.description || '').slice(0, 80)}`
        : toolName === 'Skill' ? `Skill:${toolInput.skill || toolInput.name || 'unknown'}`
        : toolName.startsWith('mcp__') ? toolName
        : toolName,
    });
  }

  return null;
}

function handleSubagentStop(input) {
  events.logEvent('subagent_complete', {
    session_id: input.session_id,
    project: getProject(input),
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  });
  return null;
}

function handleStop(input) {
  events.logEvent('turn_end', {
    session_id: input.session_id,
    project: getProject(input),
  });
  return null;
}

function handleStopFailure(input) {
  events.logEvent('error', {
    session_id: input.session_id,
    project: getProject(input),
    error_type: input.error_type,
  });
  return null;
}

// ─── Main ─────────────────────────────────────────

async function main() {
  const input = await readStdin();
  const event = input.hook_event_name;

  let output = null;

  switch (event) {
    case 'SessionStart':
      output = handleSessionStart(input);
      break;
    case 'UserPromptSubmit':
      output = handleUserPromptSubmit(input);
      break;
    case 'PreToolUse':
      output = handlePreToolUse(input);
      break;
    case 'SubagentStop':
      output = handleSubagentStop(input);
      break;
    case 'Stop':
      output = handleStop(input);
      break;
    case 'StopFailure':
      output = handleStopFailure(input);
      break;
    default:
      // Unknown event — log it but don't output anything
      events.logEvent('unknown_hook', { event, session_id: input.session_id });
      break;
  }

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`Token Coach hook error: ${err.message}\n`);
  process.exit(1); // Non-zero but not 2 — don't block
});
