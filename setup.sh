#!/bin/bash
set -e

# ─── Token Coach Setup ─────────────────────────────
# Installs hooks into Claude Code, creates data dirs,
# and optionally starts the dashboard.
# Run: bash setup.sh
# ────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/bin/hook-router.js"
SETTINGS_FILE="$HOME/.claude/settings.json"
DATA_DIR="$HOME/.token-coach"
PORT="${1:-6099}"

echo "╔══════════════════════════════════════╗"
echo "║   Token Coach — Smart Model Router   ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 1. Verify prerequisites ──────────────────────

if ! command -v node &>/dev/null; then
  echo "❌ Node.js is required. Install it first."
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "⚠️  Claude Code CLI not found. Hooks will be installed but won't activate until Claude Code is available."
fi

echo "✓ Prerequisites OK"

# ─── 2. Create data directories ───────────────────

mkdir -p "$DATA_DIR/events"
mkdir -p "$DATA_DIR/archive"
echo "✓ Data directory: $DATA_DIR"

# ─── 3. Archive old data if present ───────────────

if [ -f "$SCRIPT_DIR/task-log.csv" ]; then
  ARCHIVE="$DATA_DIR/archive/task-log-$(date +%Y%m%d).csv"
  mv "$SCRIPT_DIR/task-log.csv" "$ARCHIVE"
  echo "✓ Archived old task-log.csv → $ARCHIVE"
fi

# ─── 4. Make hook executable ──────────────────────

chmod +x "$HOOK_SCRIPT"
echo "✓ Hook script: $HOOK_SCRIPT"

# ─── 5. Install hooks into Claude Code settings ───

if [ ! -f "$SETTINGS_FILE" ]; then
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  echo '{}' > "$SETTINGS_FILE"
fi

# Use node to safely merge hooks into existing settings
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));

// Ensure hooks object exists
if (!settings.hooks) settings.hooks = {};

const hookCmd = 'node $HOOK_SCRIPT';

// Define the hooks we need
const HOOKS_CONFIG = {
  'SessionStart': [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  'UserPromptSubmit': [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  'PreToolUse': [{ matcher: 'Agent', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  'SubagentStop': [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  'Stop': [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  'StopFailure': [{ matcher: '', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
};

// Remove any existing token-coach hooks, then add ours
for (const [event, hookDefs] of Object.entries(HOOKS_CONFIG)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Remove old token-coach hooks
  settings.hooks[event] = settings.hooks[event].filter(h =>
    !h.hooks?.some(hh => hh.command?.includes('hook-router.js'))
  );

  // Add new hooks
  settings.hooks[event].push(...hookDefs);
}

fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
console.log('✓ Hooks installed into ' + '$SETTINGS_FILE');
" || {
  echo "❌ Failed to install hooks. Check $SETTINGS_FILE manually."
  exit 1
}

# ─── 6. Start dashboard (optional) ────────────────

echo ""
echo "┌─────────────────────────────────────────┐"
echo "│  Setup complete!                        │"
echo "├─────────────────────────────────────────┤"
echo "│                                         │"
echo "│  Hooks installed for:                   │"
echo "│    • SessionStart (log model)           │"
echo "│    • UserPromptSubmit (classify + route) │"
echo "│    • PreToolUse/Agent (track routing)   │"
echo "│    • SubagentStop (track completion)    │"
echo "│    • Stop/StopFailure (session end)     │"
echo "│                                         │"
echo "│  Data dir: ~/.token-coach/events/       │"
echo "│                                         │"
echo "│  Dashboard:                             │"
echo "│    node src/server.js                   │"
echo "│    # or                                 │"
echo "│    pm2 start src/server.js \\            │"
echo "│      --name token-coach                 │"
echo "│                                         │"
echo "│  Open: http://localhost:$PORT             │"
echo "│                                         │"
echo "│  ⚠ Restart Claude Code for hooks to     │"
echo "│    take effect (exit and relaunch)       │"
echo "└─────────────────────────────────────────┘"
echo ""

# Save port to config if non-default
if [ "$PORT" != "6099" ]; then
  node -e "
    const config = require('$SCRIPT_DIR/src/config');
    config.set('dashboard_port', $PORT);
    console.log('✓ Dashboard port saved to config: $PORT');
  "
fi

if command -v pm2 &>/dev/null; then
  read -p "Start dashboard with PM2? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$SCRIPT_DIR"
    PORT=$PORT pm2 start src/server.js --name token-coach 2>/dev/null || pm2 restart token-coach
    echo "✓ Dashboard running at http://localhost:$PORT"
  fi
fi
