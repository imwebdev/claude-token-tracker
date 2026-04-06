<p align="center">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-blue" alt="node >= 18" />
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="MIT license" />
  <img src="https://img.shields.io/badge/data-100%25%20local-purple" alt="100% local" />
</p>

<h1 align="center">Claude Token Tracker</h1>

<p align="center">
  <strong>Stop burning money on Claude Code.</strong><br/>
  Watches your prompts in real-time and routes each task to the cheapest model that can handle it — without you doing anything differently.
</p>

<p align="center">
  <code>opus for architecture</code> &middot; <code>sonnet for edits</code> &middot; <code>haiku for lookups</code>
</p>

---

> **Disclaimer:** This is an independent community tool, not affiliated with Anthropic. Use at your own risk. There is no guarantee it will save you tokens or money — results depend on your usage patterns, prompt style, and how closely the router's classifications match your actual needs. Always review routing suggestions critically.

---

## Install

```bash
git clone https://github.com/imwebdev/claude-token-tracker.git
cd claude-token-tracker
node bin/cli.js init
```

No `npm install` needed. Zero dependencies. Seriously — zero.

**Then restart Claude Code** (exit completely and relaunch). Hooks do not take effect until you restart.

---

## Update

When a new version is released, run this from the repo folder:

```bash
cd claude-token-tracker
node bin/cli.js update
```

This pulls the latest code and restarts the dashboard. No reinstall needed.

Verify everything is working:

```bash
node bin/cli.js doctor
```

All checks should pass. If any fail, the output tells you exactly what to fix.

---

## What you will see

After install, a small routing box appears in your terminal every time you send a prompt:

```
- - - - - - - - - - - - - - - - - - - -
TOKEN COACH  search_read (low, high conf)
  model:   haiku  simple lookup -- haiku is 15x cheaper than opus
  action:  > redirect to haiku subagent
  session: ~$0.45 (12 prompts)
- - - - - - - - - - - - - - - - - - - -
```

That is it. You do not need to learn any commands. Just use Claude Code as you always have, and Token Tracker quietly nudges the model selection in the background.

---

## How it works

```
  You type a prompt
        |
        v
  +------------------+
  |  Hook intercepts  |  <-- runs in <50ms, you won't notice
  +------------------+
        |
        v
  +------------------+
  | Classify task     |  search? edit? debug? architecture?
  +------------------+
        |
        v
  +------------------+
  | Recommend model   |  haiku ($1) / sonnet ($3) / opus ($15)
  +------------------+
        |
        v
  +------------------+
  | Show routing box  |  the thing you see in terminal
  +------------------+
        |
        v
  Claude Code continues normally
  (with routing hint injected)
```

The router uses keyword pattern matching to classify prompts into families (search, edit, debug, review, plan, architecture) and recommends the cheapest model for each. It learns from your usage over time.

---

## 100% local. Works offline. No data leaves your machine.

| | |
|---|---|
| **No cloud** | Runs entirely on your computer |
| **No account** | No API key, no sign-up, nothing |
| **No telemetry** | Zero analytics, zero phone-home |
| **Offline** | Works without internet after install |
| **Your data** | Stays in `~/.token-coach/` on your machine |

---

## Requirements

- Node.js 18 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in
- PM2 (optional, for the web dashboard): `npm install -g pm2`

---

## Uninstall

```bash
cd claude-token-tracker
node bin/cli.js uninstall
```

Removes hooks from Claude Code, stops the dashboard, and removes global commands. It will ask before deleting your data.

Then restart Claude Code (exit and relaunch).

To also delete the repo folder afterward: `rm -rf claude-token-tracker`

---

## FAQ

<details>
<summary><strong>Does this slow down Claude Code?</strong></summary>
<br/>
No. The hooks run in under 50ms. You will not notice any delay.
</details>

<details>
<summary><strong>Does this change how Claude Code works?</strong></summary>
<br/>
No. Token Tracker only adds routing suggestions. It does not block anything, modify responses, or intercept your conversations. Claude Code behaves exactly the same — you just see the routing box in your terminal.
</details>

<details>
<summary><strong>Can I turn it off temporarily?</strong></summary>
<br/>
Yes. Open <code>~/.claude/settings.json</code> and remove the hooks entries. Run <code>node bin/cli.js init</code> at any time to re-install them.
</details>

<details>
<summary><strong>Where is my data stored?</strong></summary>
<br/>
Everything is in <code>~/.token-coach/</code> on your machine. Change the location with the <code>TOKEN_COACH_HOME</code> environment variable.
</details>

<details>
<summary><strong>Does this work with Claude Code for teams?</strong></summary>
<br/>
Yes. Installed per-machine. Does not interact with Anthropic's servers or your team's configuration.
</details>

---

## Advanced usage

Everything below is optional. You do not need any of this to use Token Tracker.

<details>
<summary><strong>Commands, configuration, dashboard, and more</strong></summary>

### CLI commands

All commands work as `node bin/cli.js <command>` from the repo folder, or as `claude-tokens <command>` after running `npm link`.

**Setup and health**

```bash
node bin/cli.js init              # First-time setup (default port 6099)
node bin/cli.js init --port 8080  # First-time setup on custom port
node bin/cli.js doctor            # Health check -- verify hooks, data dir, dashboard
node bin/cli.js update            # Pull latest updates, restart dashboard
```

**Analytics**

```bash
node bin/cli.js              # Token usage summary
node bin/cli.js costs        # Cost breakdown by model
node bin/cli.js insights     # Actionable recommendations
node bin/cli.js learn        # What the router has learned from your usage
node bin/cli.js audit        # Waste audit (over-routing, unnecessary escalations)
node bin/cli.js benchmark    # Benchmark data from recorded runs
node bin/cli.js dashboard    # Start the web dashboard (uses configured port, default 6099)
```

**Configuration**

```bash
node bin/cli.js config                          # View all settings
node bin/cli.js config routing_preference 20    # Set cost preference (0-100)
node bin/cli.js config daily_alert 5            # Warn when daily spend hits $5
node bin/cli.js config daily_cap 20             # Alert when daily spend hits $20
node bin/cli.js config dashboard_port 8080      # Change dashboard port
```

**Task execution (advanced)**

```bash
# Route a task -- shows recommendation but does not execute
node bin/cli.js run "search for duplicate route definitions"

# Route AND execute via Claude CLI
node bin/cli.js run --execute "fix the failing import in app.ts"

# Execute with unrestricted permissions (use with caution)
node bin/cli.js run --execute --unsafe "deploy to staging"
```

When executing, Token Tracker snapshots files before and after, spawns `claude -p` with the recommended model, validates the result, and escalates through the fallback chain (haiku to sonnet to opus) if the task fails.

---

### Routing preference

Control the cost vs. quality tradeoff with a number from 0 to 100:

```bash
node bin/cli.js config routing_preference 35
```

| Range | Mode | Behavior |
|-------|------|----------|
| 0-25 | Max savings | Aggressively uses haiku and sonnet. Opus only for architecture. |
| 26-50 | Cost-conscious (default: 35) | Sonnet-heavy. Opus for architecture and multi-file only. |
| 51-75 | Balanced | Opus for complex debug, review, and planning tasks. |
| 76-100 | Max quality | Opus for anything medium complexity or higher. |

---

### Budget alerts

```bash
node bin/cli.js config daily_alert 5    # Yellow warning at $5/day
node bin/cli.js config daily_cap 20     # Red alert at $20/day
```

Alerts appear in the routing box on every prompt once a threshold is reached.

---

### How tasks are classified

| Family | Example prompts | Default model |
|--------|----------------|---------------|
| `search_read` | "find all TODO comments", "where is the config" | haiku |
| `question` | "what does this function do", "explain the routing" | haiku |
| `code_edit` | "fix the typo", "add error handling" | sonnet |
| `command` | "run npm test", "build the project" | sonnet |
| `review` | "review the PR", "audit the security" | sonnet |
| `plan` | "plan the migration", "design the API" | sonnet |
| `debug` | "debug the 500 error", "why is this failing" | sonnet/opus |
| `multi_file` | "refactor across all files", "rewrite the auth system" | opus |
| `architecture` | "design the system architecture", "database schema" | opus |

---

### Adaptive learning

The router learns from your usage over time. Tracks success rates per task family and model, then adjusts recommendations.

```bash
node bin/cli.js learn
```

---

### Web dashboard

A local dashboard (default `http://localhost:6099`) shows:

- Today's task count by model, delegation rate, and estimated cost
- Every classified prompt with model, family, project, and status
- Actionable recommendations based on usage patterns
- Per-session cost estimates with model breakdown
- Success rates per task family and model
- Tool and agent token consumption
- Hourly activity heatmap

```bash
node bin/cli.js dashboard                # start on default port
node bin/cli.js dashboard --port 8080    # override port
```

Or run persistently with PM2:

```bash
pm2 start src/server.js --name claude-token-tracker
```

---

### Smart warnings

The routing box also warns about:

- Long sessions (20+ prompts) — suggests `/compact` or starting fresh
- Budget thresholds — when daily spend reaches your alert or cap
- Vague prompts — flags long prompts classified as "unknown"
- Suboptimal dispatches — when a subagent uses a more expensive model than needed

---

### What is logged

Token Tracker records per prompt: task classification, model recommendation, first 200 chars of prompt (for analytics), subagent dispatches, tool call names.

It does **NOT** record: full prompt text, file contents, API keys, or tool input/output payloads.

---

### Project structure

```
bin/
  cli.js                CLI entrypoint
  hook-router.js        Claude Code hook handler (all events)
src/
  router.js             Task classification and model recommendation
  learner.js            Adaptive learning from historical data
  config.js             User configuration (preference, alerts)
  init-command.js        Setup wizard and health check
  run-command.js        Task execution with file snapshots
  validator.js          Execution result validation
  escalation.js         Fallback chain (haiku -> sonnet -> opus)
  events.js             Event logging, session costs, token tracking
  ledger.js             Run persistence to ~/.token-coach/
  parser.js             Reads Claude Code data from ~/.claude/
  calculator.js         Token cost math (Anthropic pricing)
  insights.js           Actionable recommendations
  server.js             Dashboard HTTP server
  data-home.js          Path resolution for ~/.token-coach/
public/
  index.html            Dashboard UI (single file, zero dependencies)
```

</details>

---

## License

MIT
