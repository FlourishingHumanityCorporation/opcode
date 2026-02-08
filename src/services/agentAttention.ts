import { getCurrentWindow } from "@tauri-apps/api/window";

export const OPCODE_AGENT_ATTENTION_EVENT = "opcode-agent-attention";

export type AgentAttentionKind = "done" | "needs_input";
export type AgentAttentionSource =
  | "provider_session"
  | "agent_execution"
  | "agent_run_output";

export interface AgentAttentionEventDetail {
  kind: AgentAttentionKind;
  workspaceId?: string;
  terminalTabId?: string;
  title: string;
  body: string;
  source: AgentAttentionSource;
  timestamp: number;
}

export interface EmitAgentAttentionInput {
  kind: AgentAttentionKind;
  workspaceId?: string;
  terminalTabId?: string;
  source: AgentAttentionSource;
  title?: string;
  body?: string;
}

const ATTENTION_DEDUPE_WINDOW_MS = 4500;
const NEEDS_INPUT_THROTTLE_MS = 12000;
const ATTENTION_DEDUPE_LIMIT = 64;

const genericDedupeByKey = new Map<string, number>();
const needsInputByTerminal = new Map<string, number>();

let focusTrackingReady = false;
let focusListenerUnlisten: (() => void) | null = null;
let focusListenerRefCount = 0;
let windowFocused = true;
let unreadBadgeCount = 0;
let notificationPermissionRequested = false;

function hasTauriBridge(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as any).__TAURI__ ||
      (window as any).__TAURI_INTERNALS__ ||
      (window as any).__TAURI_METADATA__
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 180): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function defaultTitleForKind(kind: AgentAttentionKind): string {
  return kind === "done" ? "Agent done" : "Agent needs input";
}

function defaultBodyForKind(kind: AgentAttentionKind): string {
  if (kind === "done") {
    return "A run completed successfully.";
  }
  return "The agent is waiting for your approval or decision.";
}

function cleanupDedupeMaps(now: number): void {
  for (const [key, seenAt] of genericDedupeByKey) {
    if (now - seenAt > ATTENTION_DEDUPE_WINDOW_MS * 2) {
      genericDedupeByKey.delete(key);
    }
  }
  for (const [terminalId, seenAt] of needsInputByTerminal) {
    if (now - seenAt > NEEDS_INPUT_THROTTLE_MS * 2) {
      needsInputByTerminal.delete(terminalId);
    }
  }
}

function shouldSuppress(detail: AgentAttentionEventDetail): boolean {
  const now = detail.timestamp;
  cleanupDedupeMaps(now);

  const dedupeKey = `${detail.kind}|${detail.workspaceId ?? ""}|${
    detail.terminalTabId ?? ""
  }|${detail.body.toLowerCase()}`;
  const lastSeen = genericDedupeByKey.get(dedupeKey);
  if (typeof lastSeen === "number" && now - lastSeen < ATTENTION_DEDUPE_WINDOW_MS) {
    return true;
  }

  if (detail.kind === "needs_input" && detail.terminalTabId) {
    const lastNeedsInputSeen = needsInputByTerminal.get(detail.terminalTabId);
    if (
      typeof lastNeedsInputSeen === "number" &&
      now - lastNeedsInputSeen < NEEDS_INPUT_THROTTLE_MS
    ) {
      return true;
    }
    needsInputByTerminal.set(detail.terminalTabId, now);
  }

  genericDedupeByKey.set(dedupeKey, now);
  if (genericDedupeByKey.size > ATTENTION_DEDUPE_LIMIT) {
    const firstKey = genericDedupeByKey.keys().next().value;
    if (firstKey) {
      genericDedupeByKey.delete(firstKey);
    }
  }
  return false;
}

async function setBadgeCountSafely(count: number): Promise<void> {
  if (!hasTauriBridge()) return;

  try {
    const appWindow = getCurrentWindow();
    if (count > 0) {
      await appWindow.setBadgeCount(count);
      return;
    }
    await appWindow.setBadgeCount();
  } catch (error) {
    console.warn("[agentAttention] Failed to set badge count:", error);
  }
}

async function maybeShowDesktopNotification(
  title: string,
  body: string
): Promise<void> {
  if (!hasTauriBridge() || windowFocused) {
    return;
  }

  try {
    const notification = await import("@tauri-apps/plugin-notification");
    let granted = await notification.isPermissionGranted();

    if (!granted && !notificationPermissionRequested) {
      notificationPermissionRequested = true;
      const permission = await notification.requestPermission();
      granted = permission === "granted";
    }

    if (!granted) {
      return;
    }

    notification.sendNotification({ title, body });
  } catch (error) {
    console.warn("[agentAttention] Failed to send desktop notification:", error);
  }
}

async function ensureFocusTracking(): Promise<void> {
  if (focusTrackingReady || !hasTauriBridge()) {
    return;
  }

  focusTrackingReady = true;

  try {
    const appWindow = getCurrentWindow();
    windowFocused = await appWindow.isFocused();
    focusListenerUnlisten = await appWindow.onFocusChanged(({ payload }) => {
      windowFocused = Boolean(payload);
      if (windowFocused) {
        unreadBadgeCount = 0;
        void setBadgeCountSafely(0);
      }
    });
  } catch (error) {
    console.warn("[agentAttention] Failed to initialize focus tracking:", error);
  }
}

function dispatchAttentionEvent(detail: AgentAttentionEventDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AgentAttentionEventDetail>(OPCODE_AGENT_ATTENTION_EVENT, {
      detail,
    })
  );
}

export function initAgentAttention(): () => void {
  focusListenerRefCount += 1;
  void ensureFocusTracking();

  return () => {
    focusListenerRefCount = Math.max(0, focusListenerRefCount - 1);
    if (focusListenerRefCount !== 0) {
      return;
    }

    if (focusListenerUnlisten) {
      focusListenerUnlisten();
      focusListenerUnlisten = null;
    }
    focusTrackingReady = false;
    windowFocused = true;
    unreadBadgeCount = 0;
    void setBadgeCountSafely(0);
  };
}

function normalizeIncomingAttention(
  input: EmitAgentAttentionInput
): AgentAttentionEventDetail {
  const timestamp = Date.now();
  const title = normalizeWhitespace(
    input.title || defaultTitleForKind(input.kind)
  );
  const body = truncate(
    normalizeWhitespace(input.body || defaultBodyForKind(input.kind))
  );

  return {
    kind: input.kind,
    workspaceId: input.workspaceId,
    terminalTabId: input.terminalTabId,
    source: input.source,
    title,
    body,
    timestamp,
  };
}

export async function emitAgentAttention(
  input: EmitAgentAttentionInput
): Promise<boolean> {
  await ensureFocusTracking();
  const detail = normalizeIncomingAttention(input);
  if (shouldSuppress(detail)) {
    return false;
  }

  dispatchAttentionEvent(detail);

  if (!windowFocused) {
    unreadBadgeCount += 1;
    await setBadgeCountSafely(unreadBadgeCount);
  }

  await maybeShowDesktopNotification(detail.title, detail.body);
  return true;
}

function extractTextContentFromObject(value: Record<string, unknown>): string[] {
  const parts: string[] = [];

  if (typeof value.text === "string") {
    parts.push(value.text);
  } else if (
    value.text &&
    typeof value.text === "object" &&
    typeof (value.text as Record<string, unknown>).text === "string"
  ) {
    parts.push((value.text as Record<string, unknown>).text as string);
  }

  if (typeof value.result === "string") {
    parts.push(value.result);
  }
  if (typeof value.error === "string") {
    parts.push(value.error);
  }

  const message = value.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) {
    message.content.forEach((chunk) => {
      if (typeof chunk === "string") {
        parts.push(chunk);
        return;
      }
      if (!chunk || typeof chunk !== "object") {
        return;
      }
      const chunkRecord = chunk as Record<string, unknown>;
      if (typeof chunkRecord.text === "string") {
        parts.push(chunkRecord.text);
      } else if (
        chunkRecord.text &&
        typeof chunkRecord.text === "object" &&
        typeof (chunkRecord.text as Record<string, unknown>).text === "string"
      ) {
        parts.push((chunkRecord.text as Record<string, unknown>).text as string);
      }
    });
  }

  return parts;
}

export function extractAttentionText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const text = extractTextContentFromObject(value as Record<string, unknown>)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)
    .join(" ");

  return normalizeWhitespace(text);
}

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\b(need|needs|requires?)\s+(your|user)\s+(input|approval|confirmation|decision)\b/i,
  /\b(awaiting|waiting for)\s+(your|user)\s+(input|approval|confirmation|decision)\b/i,
  /\b(please|kindly)\s+(approve|confirm|choose|select|allow|deny)\b/i,
  /\b(do you want me to|would you like me to)\b.{0,80}\b(proceed|continue|approve|confirm|choose|select|allow|deny)\b/i,
  /\b(should i|can i)\b.{0,80}\b(proceed|continue|approve|confirm|run|apply|execute)\b/i,
  /\b(which|what)\s+(option|approach|choice|one)\b.{0,60}\b(should i|do you want|would you like|to proceed)\b/i,
  /\b(approve|approval|permission)\b.{0,60}\b(required|needed|requested)\b/i,
];

export function shouldTriggerNeedsInput(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  return NEEDS_INPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function summarizeAttentionBody(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "";
  }
  return truncate(normalized, 160);
}
