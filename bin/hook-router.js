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
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve modules relative to package root
const ROOT = path.join(__dirname, '..');
const router = require(path.join(ROOT, 'src', 'router'));
const events = require(path.join(ROOT, 'src', 'events'));
const readCache = require(path.join(ROOT, 'src', 'read-cache'));
const config = require(path.join(ROOT, 'src', 'config'));
const projectMap = require(path.join(ROOT, 'src', 'project-map'));

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

  // Inject project map to skip the exploration phase.
  // Opt-out: set session_start_map: false in ~/.token-coach/config.json.
  let cfg = {};
  try { cfg = config.read(); } catch {}
  if (cfg.session_start_map === false) return null;

  const cwd = input.cwd;
  if (!cwd) return null;

  try {
    const result = projectMap.getOrGenerate(cwd, {
      maxChars: cfg.session_start_map_max_chars || projectMap.DEFAULT_MAX_CHARS,
      ttlHours: cfg.session_start_map_ttl_hours || projectMap.DEFAULT_TTL_HOURS,
    });
    if (!result || !result.md) return null;

    events.logEvent('project_map_injected', {
      session_id: input.session_id,
      project: getProject(input),
      from_cache: !!result.fromCache,
      file_count: result.fileCount,
      bytes: Buffer.byteLength(result.md),
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.md,
      },
    };
  } catch (err) {
    // Never break session start — log and continue
    events.logEvent('project_map_error', {
      session_id: input.session_id,
      project: getProject(input),
      message: err.message,
    });
    return null;
  }
}

// Correction patterns — user is unhappy with previous turn's result
const CORRECTION_PATTERNS = /^(no[,. !]|wrong|that's not right|try again|fix (this|that|it)|redo|not what i|that didn't work|still broken|nope|incorrect)/i;

// Feedback loop: bare y/n reply pattern
const FEEDBACK_REPLY_PATTERN = /^[yn]$/i;

function handleUserPromptSubmit(input) {
  const prompt = input.prompt || '';
  const trimmed = prompt.trim();

  // ── Feedback ingestion: check if this is a y/n reply to a pending feedback request ──
  try {
    if (FEEDBACK_REPLY_PATTERN.test(trimmed)) {
      const pending = events.getSessionEvents(input.session_id, { type: 'feedback_pending', limit: 1 });
      const last = pending[pending.length - 1];
      if (last) {
        const wasCorrect = /^y$/i.test(trimmed);
        events.logEvent('user_feedback', {
          session_id: input.session_id,
          project: getProject(input),
          family: last.family,
          recommended_model: last.recommended_model,
          was_correct: wasCorrect,
        });
        if (!wasCorrect) {
          // Log a correction signal so the learner picks it up
          events.logEvent('outcome_correction', {
            session_id: input.session_id,
            project: getProject(input),
            prior_family: last.family,
            prior_model: last.recommended_model,
            prompt_preview: '[user feedback: wrong model]',
          });
        }
        // Don't classify this as a task — return early with no context injection
        return null;
      }
    }
  } catch (_) { /* never break on feedback ingestion */ }

  // Skip very short prompts (commands, yes/no answers that weren't feedback)
  if (prompt.length < 10) return null;

  // ── Correction detection: check if this prompt is correcting the previous turn ──
  if (CORRECTION_PATTERNS.test(trimmed)) {
    const lastDecision = events.getLastRoutingDecision(input.session_id);
    if (lastDecision) {
      events.logEvent('outcome_correction', {
        session_id: input.session_id,
        project: getProject(input),
        prior_family: (lastDecision.classification || {}).family || 'unknown',
        prior_model: lastDecision.recommended_model || 'opus',
        prompt_preview: trimmed.slice(0, 100),
      });
    }
  }

  const classification = router.classifyTask(prompt);
  const recommendation = router.recommendModel(classification);

  // ── Matrix override (#95) ──────────────────────────────────────────
  // Dashboard-configured routing matrix trumps the classifier output. If the
  // user has set a specific (family, complexity) cell, apply it and tag the
  // reason so the UI shows why the recommendation differs from the classifier.
  try {
    const configMod = require(path.join(ROOT, 'src', 'config'));
    const matrixModel = configMod.getMatrixCell(classification.family, classification.complexity);
    if (matrixModel && matrixModel !== recommendation.model) {
      recommendation.classifierModel = recommendation.model;
      recommendation.model = matrixModel;
      recommendation.reasons = recommendation.reasons || [];
      recommendation.reasons.unshift(`[matrix] dashboard rule: ${classification.family}/${classification.complexity} → ${matrixModel}`);
    }
  } catch (_) { /* matrix is best-effort; classifier output still works */ }

  events.logEvent('routing_decision', {
    session_id: input.session_id,
    project: getProject(input),
    prompt_preview: prompt.slice(0, 200),
    classification,
    recommended_model: recommendation.model,
    base_model: recommendation.baseModel,
    recommended_reason: recommendation.reasons.join('; '),
    actual_model: null,
    was_delegated: null,
  });

  // ── Console output (stderr → visible to user) ──
  const confidence = classification.confidence >= 0.7 ? 'high' : 'moderate';

  // Muted ANSI 256-color palette — sidebar annotation style
  const reset   = '\x1b[0m';
  const dim     = '\x1b[2m';
  const bold    = '\x1b[1m';
  // Structural chrome
  const gray    = '\x1b[38;5;243m';   // dim gray for borders/secondary labels
  const amber   = '\x1b[38;5;136m';   // warm gold for the TOKEN COACH header
  const muted   = '\x1b[38;5;245m';   // mid-gray for metadata / reasons
  // Model identity — subtle differentiation, same family
  const modelColors = {
    haiku:  '\x1b[38;5;109m',         // muted slate-blue
    sonnet: '\x1b[38;5;143m',         // muted olive-green
    opus:   '\x1b[38;5;180m',         // muted peach/terracotta
  };
  const color = modelColors[recommendation.model] || '\x1b[38;5;245m';

  const action = recommendation.model === 'haiku' ? '> redirect to haiku subagent'
    : recommendation.model === 'sonnet' ? '> redirect to sonnet subagent'
    : '* handle directly (opus)';

  // Session cost tracking
  const sessionCost = events.getSessionCost(input.session_id);
  const promptCost = events.estimatePromptCost(recommendation.model);
  const totalCost = sessionCost.estimatedCost + promptCost;
  const costStr = totalCost < 0.01 ? '<$0.01' : `~$${totalCost.toFixed(2)}`;
  const promptCount = sessionCost.prompts + 1;
  // Cost severity uses same amber/peach family — no jarring reds unless truly critical
  const costColor = totalCost > 2 ? '\x1b[38;5;167m'   // muted red-rose
    : totalCost > 0.5 ? '\x1b[38;5;136m'               // amber
    : '\x1b[38;5;107m';                                 // muted sage-green

  // ── Warnings ──
  const warnings = [];
  const warnColor  = '\x1b[38;5;136m';  // amber — same family, not a screaming yellow
  const alertColor = '\x1b[38;5;167m';  // muted rose — visible but not full red

  // Session length warning (#37)
  if (promptCount >= 20 && promptCount % 5 === 0) {
    warnings.push(`${warnColor}! Session has ${promptCount} prompts (${costStr}). Consider /compact or starting fresh.${reset}`);
  }

  // Budget alert (#21)
  try {
    const config = require(path.join(ROOT, 'src', 'config'));
    const cfg = config.read();
    if (cfg.daily_alert && totalCost >= cfg.daily_alert) {
      warnings.push(`${warnColor}! Daily spend ~$${totalCost.toFixed(2)} has reached your alert threshold ($${cfg.daily_alert}).${reset}`);
    }
    if (cfg.daily_cap && totalCost >= cfg.daily_cap) {
      warnings.push(`${alertColor}!! Daily cap ($${cfg.daily_cap}) reached. Consider stopping or switching to cheaper models.${reset}`);
    }
  } catch {}

  // Vague/long prompt warning (#38)
  if (prompt.length > 500 && classification.family === 'unknown') {
    warnings.push(`${warnColor}! Long prompt (${prompt.length} chars) classified as unknown -- vague prompts waste tokens. Be specific: file paths, line numbers, exact changes.${reset}`);
  }

  // Learning signal detection — three variants with different urgency
  const learnChanged  = recommendation.reasons.filter(r => r.startsWith('[learned]') && !r.startsWith('[learned:'));
  const learnTip      = recommendation.reasons.filter(r => r.startsWith('[learned:tip]'));
  const learnConfirm  = recommendation.reasons.filter(r => r.startsWith('[learned:confirm]'));
  const hasLearning   = learnChanged.length > 0 || learnTip.length > 0 || learnConfirm.length > 0;

  // Distinct colors: bright cyan for changes, amber for tips, sage-green for confirms
  const learnChangeColor  = '\x1b[38;5;81m';   // bright cyan — model was changed
  const learnTipColor     = '\x1b[38;5;136m';  // amber — floor blocked a downgrade
  const learnConfirmColor = '\x1b[38;5;72m';   // muted teal — confirms current routing

  let learnLine = null;
  if (learnChanged.length > 0) {
    const text = learnChanged.map(r => r.replace('[learned] ', '')).join('; ');
    learnLine = `  ${learnChangeColor}\x1b[1m◆ LEARNING:${reset} ${learnChangeColor}${text}${reset}`;
  } else if (learnTip.length > 0) {
    const text = learnTip.map(r => r.replace('[learned:tip] ', '')).join('; ');
    learnLine = `  ${learnTipColor}◇ learning tip:${reset} ${muted}${text}${reset}`;
  } else if (learnConfirm.length > 0) {
    const text = learnConfirm.map(r => r.replace('[learned:confirm] ', '')).join('; ');
    learnLine = `  ${learnConfirmColor}✓ learned:${reset} ${muted}${text}${reset}`;
  }

  const lines = [
    `${gray}- - - - - - - - - - - - - - - - - - - -${reset}`,
    `${amber}${bold}TOKEN COACH${reset}  ${gray}${classification.family} (${classification.complexity}, ${confidence} conf)${reset}`,
    `  ${gray}model:${reset}   ${color}${recommendation.model}${reset}  ${muted}${recommendation.reasons.filter(r => !r.startsWith('[learned')).join('; ')}${reset}`,
    `  ${gray}action:${reset}  ${color}${action}${reset}`,
    ...(learnLine ? [learnLine] : []),
    `  ${gray}session:${reset} ${costColor}${costStr}${reset} ${gray}(${promptCount} prompts)${reset}`,
    ...warnings,
    `${gray}- - - - - - - - - - - - - - - - - - - -${reset}`,
  ];
  process.stderr.write(lines.join('\n') + '\n');

  // Inject routing guidance as additional context.
  // NOTE: stderr is NOT displayed by Claude Code for exit-0 hooks, so the
  // colored banner above is invisible in practice.  Everything the user sees
  // must travel through additionalContext (stdout JSON → system-reminder).
  const warningLines = warnings.length > 0
    ? ' WARNINGS: ' + warnings.map(w => w.replace(/\x1b\[[0-9;]*m/g, '')).join(' | ')
    : '';
  const learnNote = learnChanged.length > 0
    ? ` [LEARNING ADJUSTMENT] ${learnChanged.map(r => r.replace('[learned] ', '')).join('; ')}.`
    : learnTip.length > 0
    ? ` [Learning tip] ${learnTip.map(r => r.replace('[learned:tip] ', '')).join('; ')}.`
    : learnConfirm.length > 0
    ? ` [Learning: confirmed] ${learnConfirm.map(r => r.replace('[learned:confirm] ', '')).join('; ')}.`
    : '';

  const ctx = [
    `[claude-token-tracker] Task classified: ${classification.family} (${classification.complexity} complexity, ${confidence} confidence).`,
    `Recommended model: ${recommendation.model.toUpperCase()}.`,
    `Reason: ${recommendation.reasons.filter(r => !r.startsWith('[learned')).join('; ') || 'routing baseline'}.${learnNote}`,
    `Session: ${costStr} (${promptCount} prompts).${warningLines}`,
  ];

  if (recommendation.model === 'haiku') {
    ctx.push('ACTION: Dispatch this to a haiku subagent. Do NOT process directly on opus.');
  } else if (recommendation.model === 'sonnet') {
    ctx.push('ACTION: Dispatch this to a sonnet subagent unless it requires complex reasoning.');
  } else {
    ctx.push('ACTION: Handle directly -- this needs opus-level reasoning.');
  }

  // Build the exact banner line so Claude copies it verbatim instead of
  // hallucinating values.  The DISPLAY instruction must be unambiguous.
  const actionShort = recommendation.model === 'haiku' ? 'dispatching to haiku subagent'
    : recommendation.model === 'sonnet' ? 'dispatching to sonnet subagent'
    : 'handling directly (opus)';
  const bannerLine = `> **[token-tracker]** ${recommendation.model.toUpperCase()} ${classification.family} (${classification.complexity}) -- ${actionShort}`;
  ctx.push(`DISPLAY: You MUST print the following line verbatim as the very first line of your response. Do NOT modify it, do NOT invent different values: ${bannerLine}`);

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
  const sessionId = input.session_id;

  // ── Read deduper: hard-block redundant reads in the same session ──
  if (toolName === 'Read') {
    let cfg = {};
    try { cfg = config.read(); } catch {}
    if (cfg.read_dedupe !== false) {
      const absPath = toolInput.file_path;
      const hasRange = toolInput.offset != null || toolInput.limit != null;
      // Only dedupe full-file reads. If Claude asks for a specific range, let it through —
      // the cached summary can't substitute for a targeted slice.
      if (absPath && !hasRange) {
        try { readCache.prune(); } catch {}
        const hit = readCache.lookup(sessionId, absPath);
        if (hit) {
          events.logEvent('read_deduped', {
            session_id: sessionId,
            project: getProject(input),
            file_path: absPath,
            line_count: hit.lineCount,
            first_read_at: hit.firstRead,
          });
          const reason = readCache.summarize(absPath, hit);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
              additionalContext: `[token-coach] ${reason} If you truly need a fresh read (file may have changed), use an explicit offset/limit range.`,
            },
          };
        }
        // Cache miss — record the read so future duplicates are caught.
        try { readCache.record(sessionId, absPath); } catch {}
      }
    }
    // Fall through (no other Read-specific behavior).
  }

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
    const reset = '\x1b[0m';
    const gray  = '\x1b[38;5;243m';
    const muted = '\x1b[38;5;245m';
    const modelColors = {
      haiku:  '\x1b[38;5;109m',
      sonnet: '\x1b[38;5;143m',
      opus:   '\x1b[38;5;180m',
    };
    const color = modelColors[modelTier] || '\x1b[38;5;245m';
    const arrow = isOptimal ? '+' : '!';
    const arrowColor = isOptimal ? '\x1b[38;5;107m' : '\x1b[38;5;136m';  // sage-green or amber
    const desc = description.slice(0, 50);
    const statusMsg = isOptimal
      ? `${arrowColor}${arrow}${reset} ${muted}optimal${reset}`
      : `${arrowColor}${arrow}${reset} ${muted}used ${modelTier} -- ${recommendation.model} would suffice${reset}`;

    process.stderr.write(
      `${gray}  -> subagent${reset} ${color}${modelTier}${reset} ${gray}${agentType}${reset} ${muted}"${desc}"${reset} ${statusMsg}\n`
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

function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id;

  // Invalidate read cache when a file is modified
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const fp = toolInput.file_path || toolInput.notebook_path;
    if (fp && sessionId) {
      try { readCache.invalidate(sessionId, fp); } catch {}
    }
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
  const lastDecision = events.getLastRoutingDecision(input.session_id);

  events.logEvent('turn_end', {
    session_id: input.session_id,
    project: getProject(input),
  });

  // Log a successful outcome for the last routing decision
  if (lastDecision) {
    // Check for escalation: was same family dispatched to a higher model?
    const dispatches = events.getSessionEvents(input.session_id, { type: 'subagent_dispatch' });
    const decisionTs = lastDecision.ts;
    const family = (lastDecision.classification || {}).family || 'unknown';
    const recModel = lastDecision.recommended_model || 'opus';
    const modelTier = { haiku: 0, sonnet: 1, opus: 2 };

    // Escalation = same family dispatched to a higher-tier model after the routing decision
    const wasEscalated = dispatches.some(d => {
      if (!d.ts || d.ts < decisionTs) return false;
      const dFamily = (d.classification || {}).family || 'unknown';
      const dModel = d.model_used || 'opus';
      return dFamily === family && (modelTier[dModel] || 0) > (modelTier[recModel] || 0);
    });

    events.logEvent('outcome', {
      session_id: input.session_id,
      project: getProject(input),
      family,
      model: recModel,
      turn_success: true,
      was_escalated: wasEscalated,
    });
  }

  // ── Feedback loop: maybe ask user to confirm model choice ──
  try {
    const config = require(path.join(ROOT, 'src', 'config'));
    const cfg = config.read();
    if (cfg.feedback_loop_enabled && lastDecision) {
      const family = (lastDecision.classification || {}).family || 'unknown';
      const recModel = lastDecision.recommended_model || 'opus';
      const confidence = (lastDecision.classification || {}).confidence || 0;

      // Skip high-confidence decisions — learner doesn't need feedback there
      const shouldSample = confidence < 0.7 && Math.random() < (cfg.feedback_loop_sample_rate || 0.1);
      if (shouldSample) {
        events.logEvent('feedback_pending', {
          session_id: input.session_id,
          project: getProject(input),
          family,
          recommended_model: recModel,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'Stop',
            additionalContext: `[token-coach feedback] DISPLAY: Append exactly this line at the very end of your response, after all other content: "(Was ${recModel} the right model? y/n)"`,
          },
        };
      }
    }
  } catch (_) { /* never break on feedback logic */ }

  return null;
}

function handleStopFailure(input) {
  const lastDecision = events.getLastRoutingDecision(input.session_id);

  events.logEvent('error', {
    session_id: input.session_id,
    project: getProject(input),
    error_type: input.error_type,
  });

  // Log a failed outcome for the last routing decision
  if (lastDecision) {
    const family = (lastDecision.classification || {}).family || 'unknown';
    const recModel = lastDecision.recommended_model || 'opus';

    events.logEvent('outcome', {
      session_id: input.session_id,
      project: getProject(input),
      family,
      model: recModel,
      turn_success: false,
      was_escalated: false,
    });
  }

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
    case 'PostToolUse':
      output = handlePostToolUse(input);
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
  // Log errors to file so users can diagnose silent failures
  try {
    const logDir = process.env.TOKEN_COACH_HOME || path.join(os.homedir(), '.token-coach');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'hook-errors.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logFile, `${ts} ${err.message}\n${err.stack}\n\n`);
  } catch (_) { /* can't even log — give up silently */ }
  process.stderr.write(`Token Coach hook error: ${err.message}\n`);
  process.exit(1); // Non-zero but not 2 — don't block
});
