#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BIN="$ROOT_DIR/src-tauri/target/debug/codeinterfacex"
TMUX_SESSION="opcode_tauri_dev"
LOG_FILE="/tmp/codeinterfacex-tauri-dev.log"

focus_opcode_window() {
  osascript -e 'tell application "System Events" to tell process "codeinterfacex" to set frontmost to true' >/dev/null 2>&1 && return 0
  osascript -e 'tell application "System Events" to tell process "stable" to set frontmost to true' >/dev/null 2>&1 && return 0
  return 1
}

is_opcode_running() {
  pgrep -f "$APP_BIN" >/dev/null 2>&1
}

start_opcode_detached() {
  if command -v tmux >/dev/null 2>&1; then
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux new-session -d -s "$TMUX_SESSION" "cd \"$ROOT_DIR\" && npm run tauri dev"
    fi
    return 0
  fi

  nohup bash -lc "cd \"$ROOT_DIR\" && npm run tauri dev" >"$LOG_FILE" 2>&1 < /dev/null &
}

if is_opcode_running; then
  focus_opcode_window || true
  echo "codeinterfacex is already running."
  exit 0
fi

start_opcode_detached

for _ in {1..45}; do
  if is_opcode_running; then
    focus_opcode_window || true
    echo "Started codeinterfacex."
    if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "Session: tmux attach -t $TMUX_SESSION"
    else
      echo "Log: $LOG_FILE"
    fi
    exit 0
  fi
  sleep 1
done

echo "Failed to detect codeinterfacex process start." >&2
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Inspect startup logs with: tmux capture-pane -pt $TMUX_SESSION | tail -n 120" >&2
else
  echo "Inspect startup log: $LOG_FILE" >&2
fi
exit 1
