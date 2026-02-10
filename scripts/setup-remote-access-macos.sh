#!/usr/bin/env bash
set -euo pipefail

UNAME_BIN="${UNAME_BIN:-uname}"
NPM_BIN="${NPM_BIN:-npm}"
CARGO_BIN="${CARGO_BIN:-cargo}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
BREW_BIN="${BREW_BIN:-brew}"
IPCONFIG_BIN="${IPCONFIG_BIN:-ipconfig}"
TAILSCALE_BIN="${TAILSCALE_BIN:-}"
TAILSCALED_BIN="${TAILSCALED_BIN:-}"

if [[ "$("${UNAME_BIN}" -s)" != "Darwin" ]]; then
  echo "This setup script is macOS-only."
  exit 1
fi

PORT="${1:-8090}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_TAURI_DIR="${REPO_ROOT}/src-tauri"

CODEINTERFACEX_LABEL="com.codeinterfacex.web"
TAILSCALE_LABEL="com.codeinterfacex.tailscaled-userspace"
CODEINTERFACEX_PLIST="${HOME}/Library/LaunchAgents/${CODEINTERFACEX_LABEL}.plist"
TAILSCALE_PLIST="${HOME}/Library/LaunchAgents/${TAILSCALE_LABEL}.plist"

CODEINTERFACEX_BIN="${SRC_TAURI_DIR}/target/debug/codeinterfacex-web"
CODEINTERFACEX_LOG_DIR="${HOME}/Library/Logs/codeinterfacex-web"

TAILSCALE_STATE_DIR="${HOME}/Library/Application Support/Tailscale"
TAILSCALE_CACHE_DIR="${HOME}/Library/Caches/Tailscale"
TAILSCALE_LOG_DIR="${HOME}/Library/Logs/tailscale"
TAILSCALE_SOCKET="${TAILSCALE_CACHE_DIR}/tailscaled.sock"
TAILSCALE_STATE="${TAILSCALE_STATE_DIR}/tailscaled.state"

GUI_DOMAIN="gui/$(id -u)"

load_agent() {
  local label="$1"
  local plist="$2"
  "${LAUNCHCTL_BIN}" bootout "${GUI_DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  "${LAUNCHCTL_BIN}" bootstrap "${GUI_DOMAIN}" "${plist}"
  "${LAUNCHCTL_BIN}" enable "${GUI_DOMAIN}/${label}" || true
  "${LAUNCHCTL_BIN}" kickstart -k "${GUI_DOMAIN}/${label}"
}

echo "Building frontend assets..."
(cd "${REPO_ROOT}" && "${NPM_BIN}" run build)

echo "Building codeinterfacex-web binary..."
(cd "${SRC_TAURI_DIR}" && "${CARGO_BIN}" build --bin codeinterfacex-web)

mkdir -p "${HOME}/Library/LaunchAgents" "${CODEINTERFACEX_LOG_DIR}"

cat > "${CODEINTERFACEX_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CODEINTERFACEX_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CODEINTERFACEX_BIN}</string>
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
  <string>${CODEINTERFACEX_LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${CODEINTERFACEX_LOG_DIR}/stderr.log</string>
</dict>
</plist>
PLIST

echo "Loading launch agent: ${CODEINTERFACEX_LABEL}"
load_agent "${CODEINTERFACEX_LABEL}" "${CODEINTERFACEX_PLIST}"

if ! command -v "${BREW_BIN}" >/dev/null 2>&1; then
  echo "Homebrew is required to install Tailscale. Install Homebrew and rerun."
  exit 1
fi

if ! "${BREW_BIN}" list tailscale >/dev/null 2>&1; then
  echo "Installing tailscale formula..."
  "${BREW_BIN}" install tailscale
fi

if [[ -z "${TAILSCALE_BIN}" || -z "${TAILSCALED_BIN}" ]]; then
  TAILSCALE_PREFIX="$("${BREW_BIN}" --prefix tailscale)"
fi
TAILSCALE_BIN="${TAILSCALE_BIN:-${TAILSCALE_PREFIX}/bin/tailscale}"
TAILSCALED_BIN="${TAILSCALED_BIN:-${TAILSCALE_PREFIX}/bin/tailscaled}"

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
LAN_IP="$("${IPCONFIG_BIN}" getifaddr en0 2>/dev/null || "${IPCONFIG_BIN}" getifaddr en1 2>/dev/null || true)"

echo
echo "Setup complete."
echo "CodeInterfaceX web URL (local): http://127.0.0.1:${PORT}"
if [[ -n "${LAN_IP}" ]]; then
  echo "CodeInterfaceX web URL (LAN):   http://${LAN_IP}:${PORT}"
fi

if "${TAILSCALE_BIN}" --socket="${TAILSCALE_SOCKET}" status >/dev/null 2>&1; then
  TS_IP="$("${TAILSCALE_BIN}" --socket="${TAILSCALE_SOCKET}" ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "${TS_IP}" ]]; then
    echo "CodeInterfaceX web URL (tailnet): http://${TS_IP}:${PORT}"
  fi
else
  echo
  echo "Tailscale needs login. Run:"
  echo "${TAILSCALE_BIN} --socket=\"${TAILSCALE_SOCKET}\" up --accept-routes=false --accept-dns=false"
fi
