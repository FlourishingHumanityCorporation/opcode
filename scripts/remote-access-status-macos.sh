#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This status script is macOS-only."
  exit 1
fi

PORT="${1:-8090}"
TS_SOCKET="${HOME}/Library/Caches/Tailscale/tailscaled.sock"

print_agent_status() {
  local label="$1"
  launchctl print "gui/$(id -u)/${label}" 2>/dev/null | awk '/state =|pid =|path =/ {print}'
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
lsof -nP -iTCP:${PORT} -sTCP:LISTEN || true

echo
echo "== opcode health =="
local_response="$(curl -sS -m 5 "http://127.0.0.1:${PORT}/api/projects" || true)"
printf '%s\n' "${local_response:0:200}"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [[ -n "${LAN_IP}" ]]; then
  lan_response="$(curl -sS -m 5 "http://${LAN_IP}:${PORT}/api/projects" || true)"
  printf '%s\n' "${lan_response:0:200}"
fi

echo
echo "== tailscale =="
if command -v tailscale >/dev/null 2>&1; then
  tailscale --socket="${TS_SOCKET}" status || true
  echo
  tailscale --socket="${TS_SOCKET}" ip -4 || true
else
  echo "tailscale CLI not found"
fi
