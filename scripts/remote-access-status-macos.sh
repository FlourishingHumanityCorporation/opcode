#!/usr/bin/env bash
set -euo pipefail

UNAME_BIN="${UNAME_BIN:-uname}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
LSOF_BIN="${LSOF_BIN:-lsof}"
CURL_BIN="${CURL_BIN:-curl}"
IPCONFIG_BIN="${IPCONFIG_BIN:-ipconfig}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"

if [[ "$("${UNAME_BIN}" -s)" != "Darwin" ]]; then
  echo "This status script is macOS-only."
  exit 1
fi

PORT="${1:-8090}"
TS_SOCKET="${HOME}/Library/Caches/Tailscale/tailscaled.sock"

print_agent_status() {
  local label="$1"
  "${LAUNCHCTL_BIN}" print "gui/$(id -u)/${label}" 2>/dev/null | awk '/state =|pid =|path =/ {print}'
}

echo "== launchd services =="
if ! print_agent_status "com.opcode.web"; then
  print_agent_status "com.paulrohde.opcode-web" || echo "com.opcode.web not loaded"
fi
if ! print_agent_status "com.opcode.tailscaled-userspace"; then
  print_agent_status "com.paulrohde.tailscaled-userspace" || echo "com.opcode.tailscaled-userspace not loaded"
fi

echo
echo "== listeners =="
"${LSOF_BIN}" -nP -iTCP:${PORT} -sTCP:LISTEN || true

echo
echo "== opcode health =="
local_response="$("${CURL_BIN}" -sS -m 5 "http://127.0.0.1:${PORT}/api/projects" || true)"
printf '%s\n' "${local_response:0:200}"

LAN_IP="$("${IPCONFIG_BIN}" getifaddr en0 2>/dev/null || "${IPCONFIG_BIN}" getifaddr en1 2>/dev/null || true)"
if [[ -n "${LAN_IP}" ]]; then
  lan_response="$("${CURL_BIN}" -sS -m 5 "http://${LAN_IP}:${PORT}/api/projects" || true)"
  printf '%s\n' "${lan_response:0:200}"
fi

echo
echo "== tailscale =="
if command -v "${TAILSCALE_BIN}" >/dev/null 2>&1; then
  "${TAILSCALE_BIN}" --socket="${TS_SOCKET}" status || true
  echo
  "${TAILSCALE_BIN}" --socket="${TS_SOCKET}" ip -4 || true
else
  echo "tailscale CLI not found"
fi
