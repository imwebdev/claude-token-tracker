# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude Token Tracker is an autonomous model router, benchmarker, and waste auditor for Claude Code. It classifies tasks, recommends the cheapest capable model, optionally executes via the Claude CLI, validates outcomes, escalates on failure, and records everything to a file-based ledger. A local dashboard (port 6099) surfaces routing history, cost breakdowns, and waste patterns.

## Commands

```bash
# Start the dashboard server (http://localhost:6099)
node src/server.js
# or
node bin/cli.js dashboard

# Print token usage summary
node bin/cli.js

# Route and execute a task
node bin/cli.js run --execute "your task description"

# Route only (no execution)
node bin/cli.js run "your task description"

# Other commands
node bin/cli.js benchmark
node bin/cli.js audit
node bin/cli.js insights
node bin/cli.js costs
```

Global CLI names (`claude-tokens`, `token-coach`) require `npm link` first.

## Architecture

Plain Node.js (no framework, no build step, no dependencies). CommonJS throughout.

### Data Flow

1. **CLI** (`bin/cli.js`) — dispatches to command handlers or starts the dashboard server
2. **Router** (`src/router.js`) — keyword-based task classifier. Maps tasks to families (`search_read`, `code_edit`, `debug`, `review`, `plan`, `command`) with complexity (`low`/`medium`/`high`), then recommends a model (`haiku`/`sonnet`/`opus`)
3. **Run Command** (`src/run-command.js`) — orchestrates execution: snapshots files before/after, spawns `claude -p` with the recommended model in `bypassPermissions` mode, validates the result, escalates through the fallback chain on failure
4. **Validator** (`src/validator.js`) — checks execution results (exit code, output presence, infrastructure failures)
5. **Escalation** (`src/escalation.js`) — defines fallback chains (haiku→sonnet→opus)
6. **Ledger** (`src/ledger.js`) — persists run records and events as JSON/JSONL files organized by date

### Data Sources (read-only)

**Parser** (`src/parser.js`) reads from two locations:
- `~/.claude/` — Claude Code's own data: `stats-cache.json`, `history.jsonl`, session files, usage logs, settings, project configs
- `~/.token-coach/` — Token Coach's own ledger: runs, events, benchmarks, reports (override with `TOKEN_COACH_HOME` env var)
- `task-log.csv` — searched in multiple locations (Token Coach home, `~/claude-usage/`, repo root)

### Dashboard

`src/server.js` — vanilla `http.createServer`. Serves `public/index.html` as static and exposes `/api/dashboard` which aggregates all data sources into a single JSON payload (stats, costs, routing analytics, insights, task log, runs, project breakdown).

### Cost Calculator

`src/calculator.js` — hardcoded Anthropic pricing per model. Calculates actual costs from `stats-cache.json` model usage and estimates optimal costs assuming a 30/40/30 opus/sonnet/haiku split.

### Task Log CSV

The `task-log.csv` in the repo root is the primary manual task log. Format: `timestamp,project,model,size,task_description`. The `model` field supports delegation notation like `opus>sonnet`. The parser's `analyzeRouting()` builds routing analytics (delegation rates, per-project/per-date breakdowns) from this.

## Key Design Decisions

- **Zero dependencies** — everything is stdlib Node.js
- **File-based storage** — no database; JSON files organized by `year/month/day` under `~/.token-coach/`
- **Two data worlds** — reads Claude Code's internal files for usage stats, maintains its own separate ledger for routing runs
- **Execution via CLI spawn** — runs tasks by spawning `claude -p` as a child process, not via API
