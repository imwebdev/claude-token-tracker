# Claude Token Tracker

Save money on Claude Code by routing tasks to the cheapest model that can handle them.

Token Tracker classifies your prompts in real-time, recommends haiku/sonnet/opus based on task complexity, tracks costs per session, learns from your routing history, and surfaces waste patterns — all through Claude Code hooks with zero configuration changes to your workflow.

## Why

Claude Code defaults to opus for everything. Opus is 5x more expensive than sonnet and 15x more expensive than haiku. Most tasks — file searches, small edits, questions — don't need opus. Token Tracker fixes this by automatically analyzing every prompt and recommending the cheapest model that will succeed.

## Quick start

```bash
git clone https://github.com/imwebdev/claude-token-tracker.git
cd claude-token-tracker
node bin/cli.js init
```

That's it. The `init` command:
1. Installs hooks into your Claude Code configuration (with backup)
2. Creates the data directory at `~/.token-coach/`
3. Writes a default config (sonnet-heavy routing)
4. Starts the dashboard via PM2 (if installed)
5. Validates everything works

No `npm install` needed — zero dependencies, pure Node.js.

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- PM2 (optional, for persistent dashboard): `npm install -g pm2`

## How it works

Token Tracker hooks into Claude Code's event system. Every time you send a prompt:

1. **Classify** — keyword rules assign a task family (`search_read`, `code_edit`, `debug`, `review`, `plan`, `architecture`, `command`, `question`) and complexity level (low/medium/high)
2. **Recommend** — maps family + complexity to the cheapest capable model, adjusted by your cost preference and adaptive learning data
3. **Display** — shows the recommendation in your terminal with session cost tracking
4. **Record** — logs the decision to `~/.token-coach/events/` for learning and analytics

The hook injects routing guidance into Claude's context, so Claude Code automatically delegates to cheaper subagents when appropriate.

### Example console output

```
───────────────────────────────────────
⚡ TOKEN COACH  search_read (low, high conf)
  Model: HAIKU  simple lookup — haiku is 15x cheaper than opus
  Action: ↓ REDIRECT to haiku subagent
  Session: ~$0.45 (12 prompts)
───────────────────────────────────────
```

## Commands

All commands work as `node bin/cli.js <command>` or `claude-tokens <command>` after `npm link`.

### Setup and health

```bash
claude-tokens init          # First-time setup — hooks, config, dashboard
claude-tokens doctor        # Health check — verify everything is working
claude-tokens update        # Pull latest updates from git, restart dashboard
```

### Configuration

```bash
claude-tokens config                          # View all settings
claude-tokens config routing_preference 20    # Set cost preference (0-100)
claude-tokens config daily_alert 5            # Warn when daily spend hits $5
claude-tokens config daily_cap 20             # Alert when daily spend hits $20
```

### Analytics

```bash
claude-tokens                # Token usage summary
claude-tokens costs          # Cost breakdown by model
claude-tokens insights       # Actionable recommendations
claude-tokens learn          # Adaptive learning stats
claude-tokens audit          # Waste audit (over-routing, escalations)
claude-tokens benchmark      # Benchmark data from recorded runs
claude-tokens dashboard      # Start the web dashboard (http://localhost:6099)
```

### Task execution

```bash
# Route a task (dry run — no execution, records recommendation)
claude-tokens run "search for duplicate route definitions"

# Route AND execute via Claude CLI
claude-tokens run --execute "fix the failing import in app.ts"

# Execute with unrestricted permissions (use with caution)
claude-tokens run --execute --unsafe "deploy to staging"
```

When executing, Token Tracker:
- Snapshots files before and after
- Spawns `claude -p` with the recommended model
- Validates the result (exit code, output, file changes)
- Escalates through the fallback chain on failure (haiku → sonnet → opus)
- Records the full run to the ledger

## Routing preference

Control the cost vs quality tradeoff:

```bash
claude-tokens config routing_preference <0-100>
```

| Range | Mode | Behavior |
|-------|------|----------|
| 0–25 | Max savings | Aggressively uses haiku and sonnet. Opus only for architecture. |
| 26–50 | Cost-conscious (default: 35) | Sonnet-heavy. Opus for architecture and multi-file only. |
| 51–75 | Balanced | Opus for complex debug, review, and planning tasks. |
| 76–100 | Max quality | Opus for anything medium complexity or higher. |

At the default setting of 35, the router produces roughly 57% sonnet, 14% haiku, and 29% opus across a typical workload.

## Budget alerts

Set spending thresholds to avoid surprises:

```bash
claude-tokens config daily_alert 5    # Yellow warning at $5/day
claude-tokens config daily_cap 20     # Red alert at $20/day
```

Alerts appear in the hook console output on every prompt once the threshold is reached. Cost estimates are based on average token usage per prompt per model tier.

## Adaptive learning

The router learns from your usage patterns. It tracks success rates per task family and model combination, then adjusts recommendations over time.

- Minimum 5 samples before making adjustments
- Recent events (14 days) weighted 2x
- Architecture tasks never downgrade below opus (safety floor)
- Downgrades only apply when your preference is cost-conscious (≤50)
- 5-minute cache to avoid re-reading events on every prompt

View what the system has learned:

```bash
claude-tokens learn
```

Example output:

```
  Token Coach — Adaptive Learning

  Samples: 124  |  Families tracked: 10

  ✓ sonnet  code_edit      100% (13 samples)  confirm
  ✓ sonnet  command         95% (21 samples)  confirm
  · haiku   search_read     73% (11 samples)  tracking
  · opus    debug            78% (9 samples)  tracking
```

When the learner overrides a recommendation, you'll see a `Learned:` line in the console output explaining the adjustment.

## Dashboard

A local web dashboard at `http://localhost:6099` showing:

- **Metrics bar** — today's task count by model, delegation rate, estimated cost
- **Routing timeline** — every classified prompt with model, family, project, and delegation status
- **Insights** — actionable recommendations based on usage patterns
- **Session costs** — per-session cost estimates with model breakdown
- **Adaptive learning** — success rates per family and model, suggested adjustments
- **Token consumers** — which agent types, MCP servers, and tools use the most resources
- **Activity heatmap** — hourly usage patterns

Start it:

```bash
claude-tokens dashboard

# Or via PM2 for persistence:
pm2 start src/server.js --name claude-token-tracker
```

Default port is 6099. Override with `PORT=8080 claude-tokens dashboard`.

The dashboard auto-refreshes every 30 seconds with smooth data updates — no full page reloads.

## Smart warnings

The hook console will warn you about:

- **Long sessions** — at 20+ prompts, suggests `/compact` or starting fresh
- **Budget thresholds** — when daily spend reaches your alert/cap settings
- **Vague prompts** — flags prompts over 500 chars classified as "unknown" (these waste the most tokens)
- **Suboptimal dispatches** — when a subagent uses a more expensive model than recommended

## Data and privacy

All data stays local on your machine. Nothing is sent to external servers.

**Storage location:** `~/.token-coach/` (override with `TOKEN_COACH_HOME` env var)

```
~/.token-coach/
├── config.json         # Your settings (preference, alerts)
├── events/             # Hook event logs (JSONL, daily rotation)
├── runs/               # Execution records (JSON, by date)
├── benchmarks/         # Aggregated benchmark data
├── reports/
├── projects/
└── cache/
```

**What's logged:**
- Task classification and model recommendation per prompt
- First 200 characters of each prompt (for routing analytics)
- Subagent dispatch decisions and optimality
- Tool call names (not inputs/outputs)
- Session IDs and timestamps

**What's NOT logged:**
- Full prompt text
- File contents or code
- API keys or credentials
- Tool input/output payloads

## Task classification

The router classifies prompts into families using keyword pattern matching:

| Family | Example prompts | Default model |
|--------|----------------|---------------|
| `search_read` | "find all TODO comments", "where is the config" | haiku |
| `question` | "what does this function do", "explain the routing" | haiku |
| `code_edit` | "fix the typo", "update the README", "add error handling" | sonnet |
| `command` | "run npm test", "build the project" | sonnet |
| `review` | "review the PR", "audit the security" | sonnet |
| `plan` | "plan the migration", "design the API" | sonnet |
| `debug` | "debug the 500 error", "why is this failing" | sonnet/opus |
| `multi_file` | "refactor across all files", "rewrite the auth system" | opus |
| `architecture` | "design the system architecture", "database schema" | opus |

Classifications are adjusted by complexity modifiers (e.g., "entire", "comprehensive" → high complexity) and your routing preference.

## Updating

```bash
claude-tokens update
```

This pulls the latest changes from the repository, stashes any local modifications, and restarts the PM2 dashboard if running.

## Troubleshooting

Run the health check:

```bash
claude-tokens doctor
```

This verifies:
- Claude CLI is installed
- All 6 hooks are configured
- Data directory exists
- Hook script is accessible
- Dashboard is running
- Router is functioning

Common issues:

- **Dashboard shows "Loading..."** — the API server may not be running. Start it with `claude-tokens dashboard`.
- **No routing events** — hooks may not be installed. Run `claude-tokens init` to install them.
- **Hook errors in console** — check `claude-tokens doctor` for diagnostics.
- **Stale data** — the dashboard auto-refreshes every 30s. Hard refresh the browser if needed.

## Project structure

```
bin/
  cli.js                CLI entrypoint
  hook-router.js        Claude Code hook handler (all events)
src/
  router.js             Task classification + model recommendation
  learner.js            Adaptive learning from historical data
  config.js             User configuration (preference, alerts)
  init-command.js        Setup wizard + health check
  run-command.js         Task execution with file snapshots
  validator.js           Execution result validation
  escalation.js          Fallback chain (haiku → sonnet → opus)
  events.js              Event logging + session costs + token hogs
  ledger.js              Run persistence to ~/.token-coach/
  parser.js              Reads Claude Code data from ~/.claude/
  calculator.js          Token cost math (Anthropic pricing)
  insights.js            Actionable recommendations
  benchmarks.js          Run data aggregation
  waste.js               Over-routing detection
  server.js              Dashboard HTTP server
  storage.js             JSON/JSONL file helpers
  data-home.js           Path resolution for ~/.token-coach/
  audit-command.js       CLI audit output
  benchmark-command.js   CLI benchmark output
public/
  index.html             Dashboard UI (single file, zero dependencies)
```

## License

MIT
