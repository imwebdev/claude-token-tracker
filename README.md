<p align="center">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-blue" alt="node >= 18" />
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="MIT license" />
  <img src="https://img.shields.io/badge/data-100%25%20local-purple" alt="100% local" />
</p>

<h1 align="center">Claude Token Tracker</h1>

<p align="center">
  <strong>Cut Claude Code token waste.</strong><br/>
  Blocks redundant file reads, injects a project map so Claude skips exploration, recommends cheaper models per prompt, and tracks cost honestly on a local dashboard.
</p>

<p align="center">
  <code>hard-block duplicate reads</code> &middot; <code>inject project map at session start</code> &middot; <code>recommend haiku/sonnet/opus per task</code>
</p>

---

> **Disclaimer:** Independent community tool, not affiliated with Anthropic. Results depend on your usage — the dedupe and map features save measured tokens, but "how much money it saves you" is workload-dependent. The dashboard shows the raw trend separately from the directly-attributed deduper savings so you can judge for yourself. See [What it does / what it doesn't do](#what-it-does--what-it-doesnt-do) below for the honest scope.

---

## What it does / what it doesn't do

**Does:**
- **Hard-blocks redundant `Read` tool calls** in the same session — the `PreToolUse` hook returns `permissionDecision: "deny"` so the re-read never happens and the file content never re-enters Claude's context. Every blocked read is counted on the dashboard.
- **Injects a project file-map at session start** — the `SessionStart` hook emits a markdown summary (directories, notable files, one-line descriptions) so Claude doesn't burn 50–200k tokens on "let me explore this repo first."
- **Recommends a cheaper model per prompt** — classifies your prompt (search/edit/debug/plan/architecture) and renders a routing box suggesting haiku/sonnet/opus. Injected as a hint to subagent dispatches; for the main conversation it's advisory.
- **Nudges subagent dispatches** — when a `Task`/`Agent` tool call uses a more expensive model than needed, the hook injects a "this should have been sonnet" message so the parent agent learns.
- **Tracks cost honestly** — per-day real token counts from `~/.claude/stats-cache.json` (not hardcoded per-call guesses). The dashboard has a "Cost since install" chart with an install-date marker.

**Doesn't:**
- **Swap the model on the main conversation.** Claude Code's hook protocol has no field for this; `UserPromptSubmit` only supports `additionalContext` / `decision` / `systemMessage`. Our routing box is a suggestion, not an override. Anthropic's [Advisor Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) is the native API-level solution for real executor/advisor pairing — when Claude Code adopts it, this tool will defer to it.
- **Talk to Anthropic's servers.** Everything runs locally.
- **Replace `claude /cost`.** We pull the same data and show it in more views.

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

That is it. You do not need to learn any commands. Just use Claude Code as you always have — the hooks run in the background, the dashboard records what they did.

---

## How it works

Four Claude Code hooks do the work. None of them can swap the main model (the hook API doesn't allow it), but each does something measurable:

```
SessionStart
    +-- getOrGenerate(project-map)       -->  injects markdown file tree + one-liners
                                              into context; first-session-in-repo gets
                                              cached for 24h at ~/.token-coach/project-maps/

UserPromptSubmit
    +-- classifyTask(prompt)              -->  search_read / code_edit / debug /
    +-- recommendModel()                       review / plan / architecture
    +-- inject additionalContext          -->  "TOKEN COACH haiku (low) ..." banner
                                              + session cost ($X.XX) + warnings

PreToolUse (Read)
    +-- lookup(sessionId, filePath)       -->  cache hit? emit
                                              permissionDecision: "deny"
                                              -> Claude cannot re-read the file
                                              -> context unchanged, tokens saved

PreToolUse (Agent / Task)
    +-- classify the subagent's prompt    -->  if subagent model > recommended,
    +-- inject "use sonnet next time"          log suboptimal dispatch

PostToolUse (Write / Edit / MultiEdit)
    +-- invalidate(sessionId, filePath)   -->  next Read is allowed again
```

The router uses keyword pattern matching (no LLM call) to classify prompts. The file-map walker is also heuristic (first meaningful comment/line per file). Zero dependencies, sub-50ms hook budget. The learner tracks which model actually succeeded for each task family and adjusts recommendations over time.

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
Partially, and only in specific ways. The <code>PreToolUse</code> hook <em>will</em> block a redundant <code>Read</code> tool call on a file already read in the current session — Claude gets a "you already read this" message instead of the file contents. That's the deliberate token-saving behavior, and it's the one place we mechanically intervene. Everything else is additive: routing suggestions, session cost display, project-map context injection. We don't modify responses, don't intercept your conversations, and can't swap the main model (the hook API doesn't support it). You can disable deduping with <code>read_dedupe: false</code> in <code>~/.token-coach/config.json</code>.
</details>

<details>
<summary><strong>Why can't it just route my prompt to a cheaper model?</strong></summary>
<br/>
Claude Code's hook API has no field to override the model for the current turn. <code>UserPromptSubmit</code> hooks can inject context, block the turn, or set a warning banner — but they can't pick a different model. Anthropic's <a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool">Advisor Tool</a> is the native API-level answer (cheap executor + smart advisor in one request), but it's an <code>/v1/messages</code> feature, not a Claude Code feature. When Claude Code adopts it, this tool will defer to it.
</details>

<details>
<summary><strong>Does this actually save me money?</strong></summary>
<br/>
Two parts to the answer. <strong>Directly attributed:</strong> yes — every blocked redundant read is a measurable byte of context that didn't get sent. The dashboard counts those. <strong>Overall cost trend:</strong> depends on your workload. We show both separately on the "Cost since install" chart so you're not misled; raw spend trends reflect how much you're using Claude, not how well this tool worked.
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
node bin/cli.js regenerate-map    # Force-rebuild the SessionStart project map for cwd
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
node bin/cli.js config read_dedupe false        # Disable PreToolUse Read blocking
node bin/cli.js config session_start_map false  # Disable SessionStart project-map injection
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

A dashboard (default port 6099) shows:

- Today's task count by model, delegation rate, and estimated cost
- Every classified prompt with model, family, project, and status
- Actionable recommendations based on usage patterns
- Per-session cost estimates with model breakdown
- Success rates per task family and model
- Tool and agent token consumption
- Hourly activity heatmap

`node bin/cli.js init` starts the dashboard automatically via PM2, binds it to all interfaces (`0.0.0.0`), and registers it with systemd so it survives reboots. Access it at:

```
http://<your-server-ip>:6099
```

If you're running Claude Code locally (not on a remote server), use `http://localhost:6099`.

To make it survive reboots on a fresh machine, `init` will print one `sudo` command to run — copy-paste it once and it's done:

```bash
node bin/cli.js init    # prints the sudo startup command if needed
```

Manual dashboard commands (only needed if not using PM2):

```bash
node bin/cli.js dashboard                # start on default port
node bin/cli.js dashboard --port 8080    # override port
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
  config.js             User configuration (preference, alerts, feature flags)
  init-command.js       Setup wizard and health check
  install-meta.js       Records install date for the cost-since-install chart
  read-cache.js         Per-session file-read cache (powers the Read deduper)
  project-map.js        SessionStart file-map generator + 24h cache
  run-command.js        Task execution with file snapshots
  validator.js          Execution result validation
  escalation.js         Fallback chain (haiku -> sonnet -> opus)
  events.js             Event logging, session costs, dedupe stats
  ledger.js             Run persistence to ~/.token-coach/
  parser.js             Reads Claude Code data from ~/.claude/
  calculator.js         Token cost math + per-day series
  insights.js           Actionable recommendations
  server.js             Dashboard HTTP server
  data-home.js          Path resolution for ~/.token-coach/
public/
  index.html            Dashboard UI (single file, zero dependencies)
test/
  classifier-benchmark.js    Router accuracy (172 labeled cases)
  read-cache.test.js         Per-session cache
  project-map.test.js        Project-map generator
  install-cost.test.js       Install-date marker + daily cost
  dedupe-stats.test.js       Aggregator for read_deduped events
```

</details>

---

## License

MIT
