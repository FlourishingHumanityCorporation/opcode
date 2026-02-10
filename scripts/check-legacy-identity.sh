#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST_FILE="$ROOT_DIR/scripts/rebrand-legacy-allowlist.txt"

if [[ ! -f "$ALLOWLIST_FILE" ]]; then
  echo "Missing allowlist: $ALLOWLIST_FILE" >&2
  exit 1
fi

mapfile -t ALLOWLIST < "$ALLOWLIST_FILE"
GLOBS=(--glob '!.git/**')
for entry in "${ALLOWLIST[@]}"; do
  [[ -z "$entry" || "$entry" =~ ^# ]] && continue
  GLOBS+=(--glob "!$entry")
done

PATTERN='\bopcode\b|Opcode|OPCODE|x-opcode-sync-version|X-Opcode-Sync-Version|opcode://|\.opcode\.json|opcode-web|opcode-mobile|opcode_persistent'
MATCHES="$(cd "$ROOT_DIR" && rg -n --hidden "${GLOBS[@]}" "$PATTERN" || true)"

if [[ -n "$MATCHES" ]]; then
  echo "Legacy opcode identifiers found outside allowlist:" >&2
  echo "$MATCHES" >&2
  exit 1
fi

echo "Legacy identity gate passed."
