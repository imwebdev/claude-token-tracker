const { getModelTier, estimateSessionCost, calculateTotalCosts, calculateOptimalCost } = require('./calculator');
const { detectWaste } = require('./waste');
const events = require('./events');

/**
 * Generate actionable insights from Claude Code usage data.
 * Each insight has: severity (critical|warning|info|success), title, detail, action
 */
function generateInsights(data) {
  const insights = [];
  const { stats, history, sessions, dailyLogs, taskLog, projects, mcpServers } = data;
  const runWaste = detectWaste(data.runs || []);

  // ─── Primary model mismatch check ─────────────────────────
  try {
    const config = require('./config');
    const parser = require('./parser');
    const floor = config.read().model_floor || 'sonnet';
    const tu = parser.readSessionTokenUsage();
    const bm = tu?.byModel || {};
    const opusCalls = bm.opus?.calls || 0;
    const total = opusCalls + (bm.sonnet?.calls || 0) + (bm.haiku?.calls || 0);
    const opusPct = total > 0 ? Math.round(opusCalls / total * 100) : 0;
    const opusCost = bm.opus?.cost || 0;

    if (floor !== 'opus' && opusPct > 70 && total > 10) {
      insights.push({
        _live: true,
        severity: 'warning',
        title: `${opusPct}% of API calls still run on opus ($${opusCost.toFixed(2)} today)`,
        detail: `Your model floor is set to ${floor}, but your main Claude Code session is running on opus. The floor only affects subagent routing — the primary session model is set when you start Claude Code.`,
        action: `Start Claude Code with: claude --model ${floor}. Token Coach will still upgrade to opus when a task needs it.`,
      });
    }
  } catch {}

  // ─── Live Routing Insights (from hooks — always fresh) ────
  const routingStats = events.getRoutingStats();

  if (routingStats.total > 0) {
    const recHaiku = routingStats.byRecommended.haiku || 0;
    const recSonnet = routingStats.byRecommended.sonnet || 0;
    const recOpus = routingStats.byRecommended.opus || 0;
    const delegationPct = routingStats.delegationRate;

    // Delegation rate insight
    if (routingStats.delegated > 0) {
      const optPct = routingStats.optimal > 0
        ? Math.round(routingStats.optimal / routingStats.delegated * 100) : 0;
      insights.push({
        _live: true,
        severity: optPct >= 80 ? 'success' : optPct >= 50 ? 'info' : 'warning',
        title: `${routingStats.delegated} subagent dispatches (${optPct}% optimal)`,
        detail: `Dispatches by model: Haiku ${routingStats.dispatches.haiku}, Sonnet ${routingStats.dispatches.sonnet}, Opus ${routingStats.dispatches.opus}. ${routingStats.suboptimal} used a more expensive model than recommended.`,
        action: routingStats.suboptimal > 0
          ? 'Review suboptimal dispatches — could cheaper models handle those tasks?'
          : 'All dispatches matched recommendations. Keep it up.',
      });
    } else if (recHaiku + recSonnet > 0) {
      insights.push({
        _live: true,
        severity: 'warning',
        title: `0 delegations despite ${recHaiku + recSonnet} sub-opus recommendations`,
        detail: `Token Coach recommended Haiku ${recHaiku} times and Sonnet ${recSonnet} times, but no subagent dispatches were recorded. All work is running on the primary model.`,
        action: 'Use Agent(model: "haiku") for search/read tasks and Agent(model: "sonnet") for edits/reviews to reduce costs.',
      });
    }

    // Recommendation distribution
    insights.push({
      _live: true,
      severity: 'info',
      title: `Routing: ${recOpus} opus, ${recSonnet} sonnet, ${recHaiku} haiku recommendations`,
      detail: `Out of ${routingStats.total} prompts classified. This reflects what Token Coach thinks should run where — actual delegation may differ.`,
      action: 'Compare with actual dispatch counts to measure routing compliance.',
    });
  }

  if (!stats) {
    insights.push({
      severity: 'critical',
      title: 'No usage data found',
      detail: 'stats-cache.json is missing. Claude Code may not have been used yet or the cache has not been generated.',
      action: 'Run a Claude Code session to generate usage data.',
    });
    return insights;
  }

  if (runWaste.length > 0) {
    const overRouting = runWaste.filter(f => f.type === 'over-routing').length;
    const escalations = runWaste.filter(f => f.type === 'escalation').length;
    if (overRouting > 0 || escalations > 0) {
      insights.push({
        severity: 'warning',
        title: `${overRouting + escalations} routing inefficiencies detected`,
        detail: `${overRouting} potential over-routing cases and ${escalations} escalations found in Token Coach runs.`,
        action: 'Inspect `claude-tokens audit` and tighten routing policy for repeated misses.',
      });
    }
  }

  // ─── Session Length Analysis ────────────────────────────────
  const dailyActivity = stats.dailyActivity || [];
  const longSessionDays = dailyActivity.filter(d => d.messageCount > 500 && d.sessionCount <= 2);

  if (longSessionDays.length > 0) {
    const worst = longSessionDays.reduce((a, b) => a.messageCount > b.messageCount ? a : b);
    insights.push({
      severity: 'critical',
      title: 'Marathon sessions detected',
      detail: `${longSessionDays.length} days had 500+ messages in 1-2 sessions. Worst: ${worst.messageCount} messages on ${worst.date}. Long sessions balloon the context window — every message re-sends the entire conversation history.`,
      action: 'Break work into focused sessions of 15-25 messages. Use /compact or start fresh sessions for new tasks. Target: 5+ sessions per active day.',
    });
  }

  if (stats.longestSession) {
    const ls = stats.longestSession;
    const hours = Math.round(ls.duration / 3600000);
    if (ls.messageCount > 200) {
      const estCost = estimateSessionCost(ls.messageCount, 'opus');
      insights.push({
        severity: 'warning',
        title: `Longest session: ${ls.messageCount} messages over ${hours}h`,
        detail: `Session ${ls.sessionId.slice(0, 8)}... on ${new Date(ls.timestamp).toLocaleDateString()}. Estimated cost: $${estCost.toFixed(2)}. After ~30 messages, context compaction kicks in and you lose earlier context anyway.`,
        action: 'No single session should exceed 50 messages. If you hit 20, evaluate whether to /compact or start fresh.',
      });
    }
  }

  // ─── Model Routing Efficiency ──────────────────────────────
  const modelUsage = stats.modelUsage || {};
  const totalTokens = Object.values(modelUsage).reduce((sum, m) =>
    sum + m.inputTokens + m.outputTokens, 0);

  const modelShares = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    const tier = getModelTier(model);
    const tokens = usage.inputTokens + usage.outputTokens;
    modelShares[tier] = (modelShares[tier] || 0) + tokens;
  }

  const opusPct = totalTokens > 0 ? (modelShares.opus || 0) / totalTokens * 100 : 0;
  const sonnetPct = totalTokens > 0 ? (modelShares.sonnet || 0) / totalTokens * 100 : 0;
  const haikuPct = totalTokens > 0 ? (modelShares.haiku || 0) / totalTokens * 100 : 0;

  if (opusPct > 80) {
    insights.push({
      severity: 'critical',
      title: `${opusPct.toFixed(0)}% of tokens go to Opus`,
      detail: `Model split: Opus ${opusPct.toFixed(0)}%, Sonnet ${sonnetPct.toFixed(0)}%, Haiku ${haikuPct.toFixed(0)}%. Opus is 5x more expensive than Sonnet and 15x more than Haiku. Most file searches, small edits, and planning tasks don't need Opus.`,
      action: 'Target ratio: 30% Opus (complex tasks), 40% Sonnet (edits, reviews), 30% Haiku (search, exploration). Use subagents with model: "haiku" or "sonnet" for appropriate tasks.',
    });
  } else if (opusPct > 60) {
    insights.push({
      severity: 'warning',
      title: `Opus usage at ${opusPct.toFixed(0)}% — room to optimize`,
      detail: `Current: Opus ${opusPct.toFixed(0)}%, Sonnet ${sonnetPct.toFixed(0)}%, Haiku ${haikuPct.toFixed(0)}%.`,
      action: 'Push more exploration and small edit tasks to Sonnet/Haiku subagents.',
    });
  } else {
    insights.push({
      severity: 'success',
      title: 'Good model routing',
      detail: `Opus ${opusPct.toFixed(0)}%, Sonnet ${sonnetPct.toFixed(0)}%, Haiku ${haikuPct.toFixed(0)}%. You're distributing work across tiers.`,
      action: 'Keep it up. Monitor weekly to prevent drift.',
    });
  }

  // ─── Cost Analysis ─────────────────────────────────────────
  const costs = calculateTotalCosts(modelUsage);
  const optimal = calculateOptimalCost(modelUsage);

  if (optimal.savings > 5) {
    insights.push({
      severity: 'warning',
      title: `Estimated $${optimal.savings.toFixed(2)} in potential savings (${optimal.savingsPercent.toFixed(0)}%)`,
      detail: `Current estimated spend: $${optimal.current.toFixed(2)}. With optimal model routing (30/40/30 split): $${optimal.optimal.toFixed(2)}.`,
      action: 'Route search/read tasks to Haiku, edits/reviews to Sonnet, only complex multi-file work to Opus.',
    });
  }

  // ─── Cache Efficiency ──────────────────────────────────────
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInput = 0;

  for (const usage of Object.values(modelUsage)) {
    totalCacheRead += usage.cacheReadInputTokens;
    totalCacheWrite += usage.cacheCreationInputTokens;
    totalInput += usage.inputTokens;
  }

  const cacheRatio = totalInput > 0 ? totalCacheRead / (totalInput + totalCacheRead) * 100 : 0;

  if (cacheRatio > 99) {
    insights.push({
      severity: 'info',
      title: `${cacheRatio.toFixed(1)}% cache hit rate`,
      detail: `${(totalCacheRead / 1e9).toFixed(1)}B cache reads vs ${(totalInput / 1e6).toFixed(1)}M fresh input tokens. High cache rate means long conversations are re-sending previous context — this is expected but expensive at scale.`,
      action: 'Shorter sessions = less context re-sent = fewer cache reads. Each message in a 100-msg conversation re-sends ~100K tokens of cached context.',
    });
  }

  // ─── Activity Patterns ─────────────────────────────────────
  const hourCounts = stats.hourCounts || {};
  const totalHourMsgs = Object.values(hourCounts).reduce((a, b) => a + b, 0);
  const lateNight = (hourCounts['0'] || 0) + (hourCounts['1'] || 0) + (hourCounts['2'] || 0) +
    (hourCounts['3'] || 0) + (hourCounts['4'] || 0) + (hourCounts['5'] || 0);
  const lateNightPct = totalHourMsgs > 0 ? lateNight / totalHourMsgs * 100 : 0;

  if (lateNightPct > 30) {
    insights.push({
      severity: 'warning',
      title: `${lateNightPct.toFixed(0)}% of work happens between midnight and 6am`,
      detail: 'Late-night sessions tend to be longer, less focused, and burn more tokens. Fatigue leads to vague prompts that require more back-and-forth.',
      action: 'Consider batching late-night work into focused morning sessions with clear task lists.',
    });
  }

  // ─── Messages per session efficiency ───────────────────────
  if (stats.totalSessions > 0 && stats.totalMessages > 0) {
    const avgMsgsPerSession = stats.totalMessages / stats.totalSessions;
    if (avgMsgsPerSession > 100) {
      insights.push({
        severity: 'warning',
        title: `Average ${Math.round(avgMsgsPerSession)} messages per session`,
        detail: `${stats.totalMessages.toLocaleString()} total messages across ${stats.totalSessions.toLocaleString()} sessions. Each message after ~30 re-sends the entire context window.`,
        action: 'Target 15-25 messages per session. Start new sessions for new tasks. Use /compact at the 20-message mark.',
      });
    } else if (avgMsgsPerSession < 30) {
      insights.push({
        severity: 'success',
        title: `Healthy session length: avg ${Math.round(avgMsgsPerSession)} messages`,
        detail: 'Short, focused sessions keep context costs low.',
        action: 'Keep it up.',
      });
    }
  }

  // ─── MCP Server Analysis (#52) ────────────────────────────
  if (mcpServers) {
    for (const [projectName, serverInfo] of Object.entries(mcpServers)) {
      const { enabled, disabled, projectPath } = serverInfo;
      if (enabled.length === 0) continue;
      // ~800 tokens overhead per server per message (tool definitions in system prompt)
      const tokenOverheadPerMsg = enabled.length * 800;
      const msgs = stats?.totalMessages || 0;
      const msgsToday = (stats?.dailyActivity || []).slice(-1)[0]?.messageCount || 0;
      const opusPrice = 15 / 1_000_000; // input cost per token
      const dailyCostEst = msgsToday * tokenOverheadPerMsg * opusPrice;
      const severity = enabled.length >= 5 ? 'critical' : enabled.length >= 3 ? 'warning' : 'info';
      insights.push({
        _live: true,
        severity,
        title: `${projectName}: ${enabled.length} MCP server${enabled.length > 1 ? 's' : ''} active — ~${(tokenOverheadPerMsg / 1000).toFixed(1)}K tokens per message`,
        detail: `Active: ${enabled.join(', ')}. Every message you send includes all MCP server tool definitions in the system prompt${dailyCostEst > 0.01 ? ` — estimated $${dailyCostEst.toFixed(2)}/day overhead` : ''}. Disabled: ${disabled.length > 0 ? disabled.join(', ') : 'none'}.`,
        action: `Disable unused servers in ${projectPath}/.claude/settings.json → disabledMcpServers. Only keep servers this project actually uses.`,
      });
    }
  }

  // ─── CLAUDE.md Bloat Detection (#53) ──────────────────────
  try {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const claudeMdPaths = [
      { file: path.join(os.homedir(), '.claude', 'CLAUDE.md'), label: '~/.claude/CLAUDE.md' },
      { file: path.join(os.homedir(), 'CLAUDE.md'), label: '~/CLAUDE.md' },
    ];
    let totalTokens = 0;
    const breakdown = [];
    for (const { file, label } of claudeMdPaths) {
      if (fs.existsSync(file)) {
        const size = fs.readFileSync(file, 'utf-8').length;
        const tokens = Math.round(size / 4); // ~4 chars per token
        totalTokens += tokens;
        breakdown.push(`${label}: ~${tokens.toLocaleString()} tokens`);
      }
    }
    if (totalTokens > 1000) {
      const msgsToday = (stats?.dailyActivity || []).slice(-1)[0]?.messageCount || 0;
      const opusPrice = 15 / 1_000_000;
      const dailyCost = msgsToday * totalTokens * opusPrice;
      const severity = totalTokens > 4000 ? 'critical' : totalTokens > 2000 ? 'warning' : 'info';
      insights.push({
        _live: true,
        severity,
        title: `CLAUDE.md adds ~${totalTokens.toLocaleString()} tokens to every message${dailyCost > 0.05 ? ` (~$${dailyCost.toFixed(2)}/day)` : ''}`,
        detail: `Your global instructions are included in every prompt. ${breakdown.join(', ')}. The larger these files, the more every conversation costs — even quick questions.`,
        action: 'Move project-specific rules into per-project CLAUDE.md files. Keep the global ~/.claude/CLAUDE.md focused on truly universal preferences only.',
      });
    }
  } catch {}

  // ─── Repeated Tool Call Detection (#54) ───────────────────
  try {
    const recentEvents = events.readEvents({ limit: 500 });
    const toolCalls = recentEvents.filter(e => e.type === 'tool_call');

    // Group by session, then find repeated file reads and bash commands
    const bySession = {};
    for (const ev of toolCalls) {
      const sid = ev.session_id || 'unknown';
      if (!bySession[sid]) bySession[sid] = [];
      bySession[sid].push(ev);
    }

    const repeatedReads = {}; // "filepath" -> count across all sessions today
    const repeatedBash = {};  // "command_prefix" -> count

    for (const calls of Object.values(bySession)) {
      const readCounts = {};
      const bashCounts = {};
      for (const ev of calls) {
        if (ev.tool === 'Read') {
          // Extract file path from summary like "write /path/to/file" or just the path
          const fp = (ev.summary || '').replace(/^(read|write|edit)\s+/i, '').trim().slice(0, 80);
          if (fp) readCounts[fp] = (readCounts[fp] || 0) + 1;
        }
        if (ev.tool === 'Bash') {
          const cmd = (ev.summary || '').slice(0, 50).trim();
          if (cmd) bashCounts[cmd] = (bashCounts[cmd] || 0) + 1;
        }
      }
      for (const [fp, count] of Object.entries(readCounts)) {
        if (count >= 3) repeatedReads[fp] = Math.max(repeatedReads[fp] || 0, count);
      }
      for (const [cmd, count] of Object.entries(bashCounts)) {
        if (count >= 3) repeatedBash[cmd] = Math.max(repeatedBash[cmd] || 0, count);
      }
    }

    const topReads = Object.entries(repeatedReads).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topBash = Object.entries(repeatedBash).sort((a, b) => b[1] - a[1]).slice(0, 2);

    if (topReads.length > 0) {
      const examples = topReads.map(([fp, n]) => `"${fp.split('/').pop()}" ×${n}`).join(', ');
      insights.push({
        _live: true,
        severity: 'warning',
        title: `Repeated file reads detected: ${examples}`,
        detail: `The same files are being read multiple times per session. Each re-read sends the full file content again, wasting tokens. Files: ${topReads.map(([fp, n]) => `${fp} (×${n})`).join('; ')}.`,
        action: 'Read files once and keep results in context. Use the Read tool at the start of a task, not repeatedly throughout.',
      });
    }
    if (topBash.length > 0) {
      const examples = topBash.map(([cmd, n]) => `"${cmd.slice(0, 30)}" ×${n}`).join(', ');
      insights.push({
        _live: true,
        severity: 'info',
        title: `Repeated commands detected: ${examples}`,
        detail: `The same shell commands are running multiple times. Repeated polling or status checks burn tokens without adding new information.`,
        action: 'Cache command output where possible. Avoid re-running the same diagnostic commands — read the result once and proceed.',
      });
    }
  } catch {}

  // ─── Rate Limit Analysis ───────────────────────────────────
  if (dailyLogs) {
    const errorDays = Object.entries(dailyLogs.errors || {}).filter(([, count]) => count > 0);
    if (errorDays.length > 3) {
      const totalErrors = errorDays.reduce((sum, [, c]) => sum + c, 0);
      insights.push({
        severity: 'warning',
        title: `${totalErrors} rate limits across ${errorDays.length} days`,
        detail: 'Rate limits mean you hit the token ceiling. This usually happens in long sessions with rapid-fire messages.',
        action: 'Space out intense work. Use Sonnet/Haiku for lower-priority tasks to stay under Opus rate limits.',
      });
    }
  }

  // ─── Task Log Analysis ─────────────────────────────────────
  if (taskLog && taskLog.length > 0) {
    const sizeCounts = { S: 0, M: 0, L: 0 };
    const modelCounts = {};
    for (const t of taskLog) {
      sizeCounts[t.size] = (sizeCounts[t.size] || 0) + 1;
      modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
    }

    const largeTaskPct = taskLog.length > 0 ? (sizeCounts.L || 0) / taskLog.length * 100 : 0;
    if (largeTaskPct > 40) {
      insights.push({
        severity: 'warning',
        title: `${largeTaskPct.toFixed(0)}% of logged tasks are size L`,
        detail: 'Large tasks consume the most tokens. Breaking them into smaller pieces gives you more control and reduces context bloat.',
        action: 'Break L tasks into 2-3 M tasks. Use /plan before starting to identify independent subtasks that can run as subagents.',
      });
    }
  }

  // ─── Staleness Check ──────────────────────────────────────
  if (stats.lastComputedDate) {
    const lastDate = new Date(stats.lastComputedDate);
    const daysSinceUpdate = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
    if (daysSinceUpdate > 7) {
      // Demote stale stats-cache insights so live data dominates
      for (const insight of insights) {
        if (!insight._live) {
          insight.title = `[Historical] ${insight.title}`;
          if (insight.severity === 'critical') insight.severity = 'info';
        }
      }
      insights.push({
        severity: 'info',
        title: `Stats cache is ${daysSinceUpdate} days old`,
        detail: `Last computed: ${stats.lastComputedDate}. Insights marked [Historical] are from stale cached data. Live routing insights from hooks are always current.`,
        action: 'Focus on live routing data for current accuracy.',
      });
    }
  }

  // Sort: live insights first, then by severity
  const order = { critical: 0, warning: 1, info: 2, success: 3 };
  insights.sort((a, b) => {
    if (a._live && !b._live) return -1;
    if (!a._live && b._live) return 1;
    return order[a.severity] - order[b.severity];
  });

  return insights;
}

module.exports = { generateInsights };
