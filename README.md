# Claude Token Tracker

Save money on Claude Code. It watches your prompts in real-time and routes each task to the cheapest model that can handle it — without you doing anything differently.

## Install

```bash
git clone https://github.com/imwebdev/claude-token-tracker.git
cd claude-token-tracker
node bin/cli.js init
```

To run the dashboard on a different port:

```bash
node bin/cli.js init --port 8080
```

No `npm install` needed. Zero dependencies. You are done.

**Important:** Restart Claude Code (exit and relaunch) after install for the routing hooks to take effect.

---

## 100% local. Works offline. No data leaves your machine.

- Runs entirely on your computer — no cloud, no account, no API key required
- Works offline after install — no internet connection needed
- Zero telemetry — no analytics, no usage reporting, no phone home
- Your prompts and usage data stay on your machine in `~/.token-coach/`

---

## What you will see after install

When you use Claude Code normally, you will see a small routing box appear in your terminal:

```
---------------------------------------
TOKEN COACH  search_read (low, high conf)
  Model: HAIKU  simple lookup -- haiku is 15x cheaper than opus
  Action: REDIRECT to haiku subagent
  Session: ~$0.45 (12 prompts)
---------------------------------------
```

That is it. That is the whole thing. You do not need to learn any commands. Just use Claude Code as you always have, and Token Tracker quietly suggests the cheapest model in the background.

---

## Requirements

- Node.js 18 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in
- PM2 (optional, for the web dashboard): `npm install -g pm2`

---

## Uninstall

To fully remove Claude Token Tracker:

**1. Remove the hooks from Claude Code**

Open `~/.claude/settings.json` in a text editor and delete the `hooks` section that references `hook-router.js`. A backup of your original settings was saved as `~/.claude/settings.json.backup` during install — you can restore it:

```bash
cp ~/.claude/settings.json.backup ~/.claude/settings.json
```

**2. Stop and remove the dashboard process**

```bash
pm2 stop claude-token-tracker
pm2 delete claude-token-tracker
```

(Skip this step if you did not install PM2 or never started the dashboard.)

**3. Delete the repo folder**

```bash
rm -rf /path/to/claude-token-tracker
```

Replace `/path/to/` with wherever you cloned it.

**4. Delete your local data**

```bash
rm -rf ~/.token-coach
```

This removes all logs, settings, and recorded events.

**5. Optional: remove the global CLI shortcut**

If you ran `npm link`, undo it:

```bash
cd /path/to/claude-token-tracker
npm unlink
```

---

## FAQ

**Does this slow down Claude Code?**

No. The hooks run in under 100ms. You will not notice any delay.

**Does this change how Claude Code works?**

No. Token Tracker only adds routing suggestions. It does not block anything, modify responses, or intercept your conversations. Claude Code behaves exactly the same — you just see the routing box in your terminal.

**Can I turn it off temporarily without uninstalling?**

Yes. Open `~/.claude/settings.json` and remove or comment out the hooks entries. Remove the hooks and Token Tracker goes silent. Add them back to turn it on again. Run `node bin/cli.js init` at any time to re-install the hooks.

**Where is my data stored?**

Everything is in `~/.token-coach/` on your machine. You can change this location with the `TOKEN_COACH_HOME` environment variable.

**Does this work with Claude Code for teams or enterprise?**

Yes. It is installed per-machine. It does not interact with Anthropic's servers or your team's Claude Code configuration. Each developer installs it independently on their own computer.

---

## Advanced usage

Everything below is optional. You do not need any of this to use Token Tracker.

<details>
<summary>Commands, configuration, dashboard, and more</summary>

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

At the default setting of 35, the router produces roughly 57% sonnet, 14% haiku, and 29% opus across a typical workload.

---

### Budget alerts

Set spending thresholds to avoid surprises:

```bash
node bin/cli.js config daily_alert 5    # Yellow warning at $5/day
node bin/cli.js config daily_cap 20     # Red alert at $20/day
```

Alerts appear in the routing box on every prompt once a threshold is reached.

---

### How tasks are classified

The router classifies prompts using keyword pattern matching:

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

Complexity modifiers (words like "entire", "comprehensive", "all files") bump the complexity level up, which can escalate to a more capable model.

---

### Adaptive learning

The router learns from your usage over time. It tracks success rates per task family and model, then adjusts recommendations. Architecture tasks never drop below opus regardless of learned data.

View what it has learned:

```bash
node bin/cli.js learn
```

---

### Web dashboard

A local dashboard (default `http://localhost:6099`, configurable via `--port` or `config dashboard_port`) shows:

- Today's task count by model, delegation rate, and estimated cost
- Every classified prompt with model, family, project, and status
- Actionable recommendations based on usage patterns
- Per-session cost estimates with model breakdown
- Success rates per task family and model
- Tool and agent token consumption
- Hourly activity heatmap

Start it manually:

```bash
node bin/cli.js dashboard
node bin/cli.js dashboard --port 8080   # override port for this session
```

Or run it persistently with PM2 (survives terminal close and reboots):

```bash
pm2 start src/server.js --name claude-token-tracker
```

The port is read from config (`dashboard_port`), then the `PORT` env var, then defaults to 6099.

The dashboard auto-refreshes every 30 seconds.

---

### Smart warnings

The routing box also warns about:

- Long sessions (20+ prompts) -- suggests `/compact` or starting fresh
- Budget thresholds -- when daily spend reaches your alert or cap
- Vague prompts -- flags very long prompts classified as "unknown" (these tend to waste tokens)
- Suboptimal dispatches -- when a subagent uses a more expensive model than recommended

---

### What is logged

Token Tracker records the following per prompt:

- Task classification and model recommendation
- First 200 characters of each prompt (for routing analytics only)
- Subagent dispatch decisions
- Tool call names (not their inputs or outputs)
- Session IDs and timestamps

It does NOT record:
- Full prompt text
- File contents or code
- API keys or credentials
- Tool input/output payloads

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
  init-command.js       Setup wizard and health check
  run-command.js        Task execution with file snapshots
  validator.js          Execution result validation
  escalation.js         Fallback chain (haiku to sonnet to opus)
  events.js             Event logging, session costs, token tracking
  ledger.js             Run persistence to ~/.token-coach/
  parser.js             Reads Claude Code data from ~/.claude/
  calculator.js         Token cost math (Anthropic pricing)
  insights.js           Actionable recommendations
  benchmarks.js         Run data aggregation
  waste.js              Over-routing detection
  server.js             Dashboard HTTP server
  storage.js            JSON/JSONL file helpers
  data-home.js          Path resolution for ~/.token-coach/
  audit-command.js      CLI audit output
  benchmark-command.js  CLI benchmark output
public/
  index.html            Dashboard UI (single file, zero dependencies)
```

</details>

---

## License

MIT
