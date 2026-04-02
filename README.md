# Claude Token Tracker

Local model router, cost calculator, and waste auditor for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Classifies tasks by keyword, recommends the cheapest model (haiku/sonnet/opus), optionally executes via the Claude CLI with automatic escalation on failure, and records every run to a file-based ledger. A local dashboard shows cost breakdowns, routing patterns, and waste.

## Requirements

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (required for `run --execute` and for dashboard data)

## Install

```bash
git clone https://github.com/imwebdev/claude-token-tracker.git
cd claude-token-tracker
```

No `npm install` needed — zero dependencies.

Run directly:

```bash
node bin/cli.js
```

Or link globally for the `claude-tokens` / `token-coach` commands:

```bash
npm link
```

## Commands

All commands work as `node bin/cli.js <command>` or `claude-tokens <command>` after linking.

```bash
# Print token usage summary (default)
claude-tokens

# Route a task to the recommended model (dry run, no execution)
claude-tokens run "search for duplicate route definitions"

# Route AND execute via Claude CLI
claude-tokens run --execute "fix the failing import in app.ts"

# Cost breakdown by model
claude-tokens costs

# Actionable usage insights
claude-tokens insights

# Benchmark data from recorded runs
claude-tokens benchmark

# Waste audit (over-routing, unnecessary escalation)
claude-tokens audit

# Start the dashboard on http://localhost:6099
claude-tokens dashboard
```

## How It Works

1. **Classify** — keyword-based rules assign a task family (`search_read`, `code_edit`, `debug`, `review`, `plan`, `command`) and complexity level
2. **Recommend** — maps family + complexity to a model: haiku for search/read, sonnet for bounded edits, opus for complex reasoning
3. **Execute** (with `--execute`) — spawns `claude -p` with the recommended model, snapshots files before/after to detect changes
4. **Validate** — checks exit code, output length, file changes, stderr for errors
5. **Escalate** — if validation fails, moves up the fallback chain (haiku -> sonnet -> opus)
6. **Record** — saves the full run (classification, recommendation, attempts, outcome) to `~/.token-coach/`

Without `--execute`, it records the routing recommendation only.

## Dashboard

The dashboard reads from two sources:

- **Claude Code data** (`~/.claude/`) — session history, token usage stats, model usage, daily activity. This is populated by normal Claude Code usage.
- **Token Coach ledger** (`~/.token-coach/`) — routing runs, benchmarks, events. Populated when you use `claude-tokens run`.

If you haven't used Claude Code yet, the dashboard will be mostly empty.

Start it:

```bash
claude-tokens dashboard
# or
node src/server.js
```

Default port is 6099. Override with `PORT=8080 node src/server.js`.

## Storage

All Token Coach state is stored as flat JSON/JSONL files under `~/.token-coach/`:

```
~/.token-coach/
  config.json
  runs/          # Run records organized by year/month/day
  events/        # Event log (JSONL) by day
  benchmarks/    # Aggregated benchmark data
  reports/
  projects/
  cache/
```

Override the location:

```bash
export TOKEN_COACH_HOME=/path/to/custom/dir
```

## Project Structure

```
bin/cli.js              CLI entrypoint, dispatches to command handlers
src/
  router.js             Task classification and model recommendation
  run-command.js         Orchestrates execution, file snapshots, escalation
  validator.js           Checks execution results
  escalation.js          Fallback chain logic (haiku -> sonnet -> opus)
  ledger.js              Run/event persistence to ~/.token-coach/
  storage.js             JSON/JSONL file helpers
  data-home.js           Resolves ~/.token-coach/ paths
  parser.js              Reads Claude Code data from ~/.claude/
  calculator.js          Token cost math (Anthropic pricing)
  insights.js            Generates actionable recommendations
  benchmarks.js          Aggregates run data into benchmarks
  waste.js               Detects over-routing and waste patterns
  server.js              Dashboard HTTP server + /api/dashboard endpoint
  audit-command.js       CLI audit output
  benchmark-command.js   CLI benchmark output
public/
  index.html             Dashboard single-page UI
```

## License

MIT
