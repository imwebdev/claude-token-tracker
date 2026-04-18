#!/bin/sh
# Claude Code statusline script — Claude Token Tracker
#
# Shows: session rate limit %, weekly rate limit %, and context window fill.
# Rate limits come from Anthropic's servers via the statusline JSON input.
#
# Install:
#   1. Copy this file somewhere (e.g. ~/.claude/statusline-command.sh)
#   2. Add to ~/.claude/settings.json:
#        "statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" }
#   3. Restart Claude Code.
#
# Or just run: node bin/cli.js init --statusline
# and it will install this for you automatically.

input=$(cat)

# --- Directory ---
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
dir=$(basename "$cwd")
home_base=$(basename "$HOME")
[ "$dir" = "$home_base" ] && dir="~"
ps1_part="$(whoami)@$(hostname -s) $dir"

# --- Model ---
model=$(echo "$input" | jq -r '.model.display_name // ""')

# --- Context window bar ---
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$used_pct" ]; then
  used_int=$(printf "%.0f" "$used_pct")
  filled=$(( used_int / 10 ))
  empty=$(( 10 - filled ))
  bar=""
  i=0
  while [ $i -lt $filled ]; do bar="${bar}█"; i=$(( i + 1 )); done
  i=0
  while [ $i -lt $empty ]; do bar="${bar}░"; i=$(( i + 1 )); done
  ctx_part="ctx [${bar}] ${used_int}%"
else
  ctx_part="ctx [░░░░░░░░░░] --%"
fi

# --- Session rate limit (5-hour rolling window) ---
sess_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
sess_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
if [ -n "$sess_pct" ]; then
  sess_int=$(printf "%.0f" "$sess_pct")
  if [ -n "$sess_resets" ]; then
    now_ts=$(date +%s)
    diff=$(( sess_resets - now_ts ))
    if [ $diff -gt 0 ]; then
      hrs=$(( diff / 3600 ))
      mins=$(( (diff % 3600) / 60 ))
      [ $hrs -gt 0 ] && reset_label="${hrs}h${mins}m" || reset_label="${mins}m"
      sess_part="sess ${sess_int}% (resets ${reset_label})"
    else
      sess_part="sess ${sess_int}%"
    fi
  else
    sess_part="sess ${sess_int}%"
  fi
else
  sess_part="sess --%"
fi

# --- Weekly rate limit (7-day rolling window) ---
week_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_resets=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
if [ -n "$week_pct" ]; then
  week_int=$(printf "%.0f" "$week_pct")
  if [ -n "$week_resets" ]; then
    now_ts=$(date +%s)
    diff=$(( week_resets - now_ts ))
    if [ $diff -gt 0 ]; then
      days=$(( diff / 86400 ))
      hrs=$(( (diff % 86400) / 3600 ))
      mins=$(( (diff % 3600) / 60 ))
      if [ $days -gt 0 ]; then
        wreset_label="${days}d${hrs}h"
      else
        wreset_label="${hrs}h${mins}m"
      fi
      week_part="wk ${week_int}% (resets ${wreset_label})"
    else
      week_part="wk ${week_int}%"
    fi
  else
    week_part="wk ${week_int}%"
  fi
else
  week_part="wk --%"
fi

# --- Permission mode ---
perm_mode=$(echo "$input" | jq -r '.permissions.mode // ""')
case "$perm_mode" in
  bypassPermissions) perm_part="BYPASS" ;;
  *) perm_part="" ;;
esac

if [ -n "$perm_part" ]; then
  printf "%s  |  %s  |  %s  |  %s  |  %s  |  %s\n" "$ps1_part" "$model" "$ctx_part" "$sess_part" "$week_part" "$perm_part"
else
  printf "%s  |  %s  |  %s  |  %s  |  %s\n" "$ps1_part" "$model" "$ctx_part" "$sess_part" "$week_part"
fi
