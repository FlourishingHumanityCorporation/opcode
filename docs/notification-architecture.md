# Notification Architecture

How CodeInterfaceX notifies users when agent sessions complete or need input.

## Overview

The notification system has three output channels:

1. **Native OS notifications** — desktop banners via `tauri-plugin-notification`
2. **In-app toasts** — fallback when native notifications are unavailable or denied
3. **Tab status indicators** — per-tab "attention" / "complete" badges in the tab bar

All three channels are driven by a single service (`agentAttention`) that deduplicates, throttles, and routes events based on window focus state and notification permissions.

## Data flow

```
 Trigger sources                    Attention service                    Output channels
 ───────────────                    ─────────────────                    ───────────────

 ProviderSessionPane ─┐
   (Claude sessions)  │
                      ├─→ agentAttentionStreamBridge ─→ emitAgentAttention()
 AgentExecution ──────┘       builds payload                 │
   (CC agent runs)                                           │
                                                             ▼
                                                   ┌─────────────────┐
                                                   │ Suppress check  │
                                                   │ (dedup/throttle)│
                                                   └────────┬────────┘
                                                            │
                                              ┌─────────────┼─────────────┐
                                              │             │             │
                                              ▼             ▼             ▼
                                        DOM event     Desktop notif   Fallback toast
                                      (always fired)  (if unfocused   (if unfocused
                                           │          + permitted)    + notif failed)
                                           │             │                 │
                                           ▼             ▼                 ▼
                                      Tab status     OS banner        Toast component
                                      update         + badge count    in App.tsx
```

## Key files

| File | Role |
|------|------|
| `src/services/agentAttention.ts` | Core service — init, emit, dedup, permissions, badge |
| `src/services/agentAttentionStreamBridge.ts` | Converts streaming messages into attention payloads |
| `src/services/agentAttentionRouting.ts` | Maps attention kinds to tab status values |
| `src/App.tsx` | Initializes service, handles fallback toast display |
| `src/components/TabContent.tsx` | Listens for attention events, updates tab status |
| `src/components/ui/toast.tsx` | Toast UI component |
| `src/components/ProviderSessionPane.tsx` | Emits notifications from Claude sessions |
| `src/components/AgentExecution.tsx` | Emits notifications from CC agent runs |
| `src-tauri/Cargo.toml` | Declares `tauri-plugin-notification = "2"` dependency |

## Types

```typescript
// What kind of attention is needed
type AgentAttentionKind = "done" | "needs_input";

// Where the event originated
type AgentAttentionSource =
  | "provider_session"    // Claude session
  | "agent_execution"     // CC agent run
  | "agent_run_output";   // Agent output viewer

// Main event payload (dispatched as CustomEvent on window)
interface AgentAttentionEventDetail {
  kind: AgentAttentionKind;
  workspaceId?: string;
  terminalTabId?: string;
  title: string;
  body: string;
  source: AgentAttentionSource;
  timestamp: number;
}
```

## Initialization

`App.tsx` calls `initAgentAttention()` on mount. This:

1. Registers a window focus listener (`appWindow.onFocusChanged`)
2. Resets the badge count to 0
3. Returns a ref-counted cleanup function (safe for multiple callers)

When the window regains focus, the badge count resets to 0.

## Triggering notifications

Components that stream agent output (`ProviderSessionPane`, `AgentExecution`) use the stream bridge to convert messages into attention payloads:

- **`buildDoneAttentionPayload`** — agent finished its work
- **`buildNeedsInputAttentionPayload`** — agent is waiting for user input (detected via regex patterns like "please approve", "should I…", or a `request_user_input` tool call)

Both return an `EmitAgentAttentionInput` that is passed to `emitAgentAttention()`.

## Deduplication and throttling

Two layers prevent notification spam:

| Mechanism | Scope | Window | Key |
|-----------|-------|--------|-----|
| Generic dedup | All notifications | 4.5 s | `${kind}\|${workspaceId}\|${terminalTabId}\|${body}` |
| Needs-input throttle | `needs_input` only | 12 s | `terminalTabId` (ignores body) |

Both maps self-clean when they exceed 64 entries.

## Triple dispatch

`emitAgentAttention()` performs up to three actions for each non-suppressed event:

1. **DOM event** (`codeinterfacex-agent-attention`) — always dispatched. Consumed by `TabContent.tsx` to update tab status via `applyAgentAttentionStatusUpdate()`.

2. **Desktop notification** — only if the window is unfocused. Requests permission once per session. On success, increments the macOS badge count.

3. **Fallback event** (`codeinterfacex-agent-attention-fallback`) — only if the window is unfocused AND the desktop notification was not delivered (permission denied or unavailable). Consumed by `App.tsx` and displayed as an in-app toast.

## Tab status propagation

`agentAttentionRouting.ts` maps attention kinds to tab states:

| Attention kind | Tab status |
|----------------|------------|
| `needs_input` | `"attention"` |
| `done` | `"complete"` |

`TabContent.tsx` listens for the DOM event and calls `applyAgentAttentionStatusUpdate()`, which finds the matching tab by `terminalTabId` and updates its status.

## Needs-input detection

`shouldTriggerNeedsInputFromMessage()` uses two detection strategies:

1. **Regex patterns** on extracted text — matches phrases like:
   - "requires your input/approval"
   - "awaiting/waiting for your input"
   - "please approve/confirm/choose"
   - "do you want me to…" / "should I…"

2. **Tool signal detection** — looks for `request_user_input` in the message's nested tool-use structures.

`extractAttentionText()` recursively pulls text from deeply nested message payloads (`message.content[].text`, `tool_uses[].input`, etc.), normalizes whitespace, and truncates to 180 characters.

## Fallback toast mapping

When desktop notifications fail, `mapAgentAttentionFallbackToToast()` converts the event:

| Kind | Toast type |
|------|------------|
| `needs_input` | `"info"` |
| `done` | `"success"` |

The toast auto-dismisses after 3 seconds (default).

## Test coverage

| Test file | What it covers |
|-----------|----------------|
| `agentAttention.notifications.test.ts` | Focus tracking, badge counts, permission flow, dedup, fallback dispatch |
| `agentAttention.test.ts` | Needs-input pattern matching, tool signal detection, text extraction |
| `agentAttention.fallbackToast.test.ts` | Toast mapping for fallback events |
| `agentAttentionStreamBridge.test.ts` | Stream payload to attention payload conversion |
| `AgentRunOutputViewer.attention.test.ts` | Output viewer deduplication |

## Platform details

- **Native notifications**: `@tauri-apps/plugin-notification` (Rust crate: `tauri-plugin-notification` v2)
- **Badge count**: macOS dock badge via `getCurrentWindow().setBadgeCount()`
- **No custom Rust IPC**: all notification logic lives in the TypeScript layer; Tauri provides the bridge to the OS
