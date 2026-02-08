# Remote Access on macOS (Opcode Web + Tailscale)

This guide configures a persistent Opcode web server instance and private remote access over Tailscale.

## What this sets up

1. Builds frontend assets and `opcode-web`.
2. Runs `opcode-web` on port `8090` via `launchd` user agent.
3. Runs `tailscaled` in userspace mode via `launchd` user agent.
4. Leaves desktop `opcode` app behavior unchanged.

## Quick start

From the repo root:

```bash
just remote-access-macos
```

Optional custom port:

```bash
just remote-access-macos 8090
```

## After setup

Use the status script:

```bash
just remote-access-status
```

If Tailscale reports `NeedsLogin`, complete login with:

```bash
tailscale --socket="$HOME/Library/Caches/Tailscale/tailscaled.sock" up --accept-routes=false --accept-dns=false
```

That command prints an auth URL. Open it in your browser, then rerun `just remote-access-status`.

## Automated tests

```bash
npm run test:remote-access:contracts
npm run smoke:remote-web
```

The contract suite uses simulated system binaries and does not touch real launchd/tailnet state.

## Launch agent files created

1. `~/Library/LaunchAgents/com.opcode.web.plist`
2. `~/Library/LaunchAgents/com.opcode.tailscaled-userspace.plist`

## Logs

1. `~/Library/Logs/opcode-web/stdout.log`
2. `~/Library/Logs/opcode-web/stderr.log`
3. `~/Library/Logs/tailscale/tailscaled.out.log`
4. `~/Library/Logs/tailscale/tailscaled.err.log`
