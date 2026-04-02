# Claude Token Tracker

Claude Token Tracker is a standalone local router, benchmarker, and audit layer for Claude Code.

It chooses the lowest-cost model likely to succeed, executes the task, records what actually happened, and shows you where tokens are being wasted.

If you want a stronger product-style name later, `Routewise` is a good option. For GitHub and clarity, `Claude Token Tracker` is still solid and direct.

## What It Does

- Routes tasks to the cheapest reasonable model first
- Executes tasks through the local Claude CLI
- Escalates only when validation says a stronger model is needed
- Stores its own run history outside any single project
- Benchmarks recommended model vs actual model usage
- Audits waste patterns so you can fix token burn
- Serves a local dashboard for visibility

## Why This Exists

Most people use expensive models too often because they do not have:

- a consistent routing policy
- a record of what should have been used
- proof of what was actually used
- feedback loops for waste, retries, and over-routing

Claude Token Tracker closes that loop.

It is not just a dashboard. It is a control layer.

## Core Idea

For every task, Claude Token Tracker does this:

1. Classifies the task
2. Recommends a starting model
3. Executes the task
4. Validates the outcome
5. Escalates only if needed
6. Records the full run
7. Updates benchmarks and audit findings

The goal is simple:

**Best acceptable quality at the lowest token cost**

## Standalone Storage

This tool does not use a database.

All state lives in:

`~/.token-coach/`

Structure:

```text
~/.token-coach/
  config.json
  runs/
  events/
  benchmarks/
  reports/
  projects/
  cache/
```

You can override the storage root for testing:

```bash
TOKEN_COACH_HOME=/tmp/token-coach-test
```

## Current Capabilities

- File-based run ledger
- Event log per day
- Task classification
- Model recommendation
- CLI execution through `claude -p`
- Validation of execution outcomes
- Benchmark generation
- Waste auditing
- Local dashboard API and UI

## Project Structure

Key files:

- `bin/cli.js` — CLI entrypoint
- `src/run-command.js` — routing and execution flow
- `src/router.js` — task classification and model policy
- `src/validator.js` — execution validation
- `src/escalation.js` — escalation rules
- `src/ledger.js` — run and event persistence
- `src/storage.js` — JSON and JSONL storage helpers
- `src/data-home.js` — standalone storage paths
- `src/benchmarks.js` — benchmark generation
- `src/waste.js` — waste detection
- `src/server.js` — dashboard API and server
- `public/index.html` — dashboard UI

## Installation

Requirements:

- Node.js 18+
- Claude CLI installed and authenticated

Clone the repo:

```bash
git clone <your-repo-url>
cd claude-token-tracker
```

Run it directly:

```bash
node ./bin/cli.js
```

If you want the CLI name available globally, link it:

```bash
npm link
```

Then use either:

```bash
claude-tokens
token-coach
```

## Commands

### Summary

Reads Claude usage cache and prints a token summary:

```bash
claude-tokens
```

### Run

Routes and runs a task:

```bash
claude-tokens run --execute "update sample.txt and replace alpha with beta"
```

Route only, without execution:

```bash
claude-tokens run "search for duplicate route definitions"
```

### Benchmark

Shows benchmark data from recorded runs:

```bash
claude-tokens benchmark
```

### Audit

Shows waste findings:

```bash
claude-tokens audit
```

### Insights

Shows usage insights from Claude data plus run history:

```bash
claude-tokens insights
```

### Costs

Shows model cost breakdown:

```bash
claude-tokens costs
```

### Dashboard

Starts the local dashboard:

```bash
claude-tokens dashboard
```

Default URL:

```text
http://localhost:6099
```

## How Routing Works

The router currently uses a rule-based policy.

Examples:

- search, discovery, narrow reading: prefer `haiku`
- bounded edits and focused implementation: prefer `sonnet`
- broader reasoning, planning, debugging, or synthesis: prefer `opus`

The recommendation is recorded on every run alongside:

- task family
- complexity
- fallback chain
- execution mode
- validation result
- final model used

## Benchmarking

Benchmarks compare:

- recommended model
- executed model
- success rate
- escalation rate
- route-only vs executed runs

This gives you the basis for tuning your routing policy instead of guessing.

Example output:

```text
Token Coach — Benchmarks

code_edit/sonnet
  runs: 1  executed: 1  success: 100%  escalations: 0%  route-only: 0
```

## Waste Auditing

The audit layer is designed to catch avoidable spend, including:

- over-routing
- unnecessary escalation
- repeated failed execution paths
- route-only runs with no real execution history yet

This is the mechanism that turns token usage into something actionable.

## Dashboard

The dashboard surfaces:

- routing history
- benchmark summaries
- model distribution
- insights
- project activity
- token and cost information

The long-term source of truth is the Token Coach ledger, not a repo-local CSV.

## Example Workflow

```bash
claude-tokens run --execute "fix the failing import in app.ts"
claude-tokens benchmark
claude-tokens audit
claude-tokens dashboard
```

This gives you:

- the routed execution
- the recorded outcome
- updated benchmark data
- an audit view of waste and routing quality

## Promotion Angle

If you are putting this on GitHub, the clean pitch is:

> Claude Token Tracker is an autonomous model router for Claude Code. It picks the cheapest model that can do the job, executes the work, benchmarks actual usage, and shows where tokens are being wasted.

Shorter version:

> Stop guessing which Claude model to use. Route it, run it, benchmark it.

## Current Status

This system is working now as a standalone file-based router and benchmarker.

Verified behavior includes:

- routed execution through the local Claude CLI
- actual file edits performed through Token Coach
- standalone run storage under Token Coach home
- benchmark generation from executed runs
- dashboard data built from ledger-backed runs

## Roadmap

- richer validation by task family
- stronger waste heuristics
- clearer recommended-vs-actual dashboard views
- better token and latency capture per attempt
- configurable routing policies
- project-specific overrides

## License

MIT
