#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This setup script is macOS-only."
  exit 1
fi

PORT="${1:-8090}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI_DIR="${REPO_ROOT}/src-tauri"

OPCODE_LABEL="com.opcode.web"
TAILSCALE_LABEL="com.opcode.tailscaled-userspace"
OPCODE_PLIST="${HOME}/Library/LaunchAgents/${OPCODE_LABEL}.plist"
TAILSCALE_PLIST="${HOME}/Library/LaunchAgents/${TAILSCALE_LABEL}.plist"

OPCODE_BIN="${SRC_TAURI_DIR}/target/debug/opcode-web"
OPCODE_LOG_DIR="${HOME}/Library/Logs/opcode-web"

TAILSCALE_STATE_DIR="${HOME}/Library/Application Support/Tailscale"
TAILSCALE_CACHE_DIR="${HOME}/Library/Caches/Tailscale"
TAILSCALE_LOG_DIR="${HOME}/Library/Logs/tailscale"
TAILSCALE_SOCKET="${TAILSCALE_CACHE_DIR}/tailscaled.sock"
TAILSCALE_STATE="${TAILSCALE_STATE_DIR}/tailscaled.state"

GUI_DOMAIN="gui/$(id -u)"

load_agent() {
  local label="$1"
  local plist="$2"
  launchctl bootout "${GUI_DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  launchctl bootstrap "${GUI_DOMAIN}" "${plist}"
  launchctl enable "${GUI_DOMAIN}/${label}" || true
  launchctl kickstart -k "${GUI_DOMAIN}/${label}"
}

echo "Building frontend assets..."
(cd "${REPO_ROOT}" && npm run build)

echo "Building opcode-web binary..."
(cd "${SRC_TAURI_DIR}" && cargo build --bin opcode-web)

mkdir -p "${HOME}/Library/LaunchAgents" "${OPCODE_LOG_DIR}"

cat > "${OPCODE_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OPCODE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${OPCODE_BIN}</string>
    <string>--port</string>
    <string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${SRC_TAURI_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${OPCODE_LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${OPCODE_LOG_DIR}/stderr.log</string>
</dict>
</plist>
PLIST

echo "Loading launch agent: ${OPCODE_LABEL}"
load_agent "${OPCODE_LABEL}" "${OPCODE_PLIST}"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to install Tailscale. Install Homebrew and rerun."
  exit 1
fi

if ! brew list tailscale >/dev/null 2>&1; then
  echo "Installing tailscale formula..."
  brew install tailscale
fi

TAILSCALE_PREFIX="$(brew --prefix tailscale)"
TAILSCALE_BIN="${TAILSCALE_PREFIX}/bin/tailscale"
TAILSCALED_BIN="${TAILSCALE_PREFIX}/bin/tailscaled"

mkdir -p "${TAILSCALE_STATE_DIR}" "${TAILSCALE_CACHE_DIR}" "${TAILSCALE_LOG_DIR}"

cat > "${TAILSCALE_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TAILSCALE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${TAILSCALED_BIN}</string>
    <string>--tun=userspace-networking</string>
    <string>--state=${TAILSCALE_STATE}</string>
    <string>--socket=${TAILSCALE_SOCKET}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${TAILSCALE_LOG_DIR}/tailscaled.out.log</string>
  <key>StandardErrorPath</key>
  <string>${TAILSCALE_LOG_DIR}/tailscaled.err.log</string>
</dict>
</plist>
PLIST

echo "Loading launch agent: ${TAILSCALE_LABEL}"
load_agent "${TAILSCALE_LABEL}" "${TAILSCALE_PLIST}"

sleep 1
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo
echo "Setup complete."
echo "Opcode web URL (local): http://127.0.0.1:${PORT}"
if [[ -n "${LAN_IP}" ]]; then
  echo "Opcode web URL (LAN):   http://${LAN_IP}:${PORT}"
fi

if "${TAILSCALE_BIN}" --socket="${TAILSCALE_SOCKET}" status >/dev/null 2>&1; then
  TS_IP="$("${TAILSCALE_BIN}" --socket="${TAILSCALE_SOCKET}" ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "${TS_IP}" ]]; then
    echo "Opcode web URL (tailnet): http://${TS_IP}:${PORT}"
  fi
else
  echo
  echo "Tailscale needs login. Run:"
  echo "${TAILSCALE_BIN} --socket=\"${TAILSCALE_SOCKET}\" up --accept-routes=false --accept-dns=false"
fi
