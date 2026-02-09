import { getCurrentWindow } from "@tauri-apps/api/window";

export const OPCODE_AGENT_ATTENTION_EVENT = "opcode-agent-attention";
export const OPCODE_AGENT_ATTENTION_FALLBACK_EVENT =
  "opcode-agent-attention-fallback";

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

export interface AgentAttentionFallbackEventDetail {
  kind: AgentAttentionKind;
  workspaceId?: string;
  terminalTabId?: string;
  title: string;
  body: string;
  source: AgentAttentionSource;
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
let focusTrackingInFlight = false;
let focusListenerUnlisten: (() => void) | null = null;
let focusListenerRefCount = 0;
let windowFocused = true;
let unreadBadgeCount = 0;
let notificationPermissionRequested = false;

interface DesktopNotificationResult {
  attempted: boolean;
  delivered: boolean;
}

interface AgentAttentionDeliveryStatus {
  desktopAttempted: boolean;
  desktopDelivered: boolean;
  fallbackDispatched: boolean;
}

function inferDocumentFocus(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  if (typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  return true;
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
  if (typeof window === "undefined") return;

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
  detail: AgentAttentionEventDetail
): Promise<DesktopNotificationResult> {
  if (typeof window === "undefined") {
    return { attempted: false, delivered: false };
  }

  if (windowFocused) {
    return { attempted: false, delivered: false };
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
      return { attempted: true, delivered: false };
    }

    await Promise.resolve(
      notification.sendNotification({ title: detail.title, body: detail.body })
    );
    return { attempted: true, delivered: true };
  } catch (error) {
    console.warn("[agentAttention] Failed to send desktop notification:", error);
    return { attempted: true, delivered: false };
  }
}

async function ensureFocusTracking(): Promise<void> {
  if (focusTrackingReady || focusTrackingInFlight || typeof window === "undefined") {
    return;
  }

  focusTrackingInFlight = true;

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
    focusTrackingReady = true;
  } catch (error) {
    windowFocused = inferDocumentFocus();
    console.warn("[agentAttention] Failed to initialize focus tracking:", error);
  } finally {
    focusTrackingInFlight = false;
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

function dispatchAttentionFallbackEvent(detail: AgentAttentionEventDetail): void {
  if (typeof window === "undefined") {
    return;
  }

  const fallbackDetail: AgentAttentionFallbackEventDetail = {
    kind: detail.kind,
    workspaceId: detail.workspaceId,
    terminalTabId: detail.terminalTabId,
    title: detail.title,
    body: detail.body,
    source: detail.source,
  };

  window.dispatchEvent(
    new CustomEvent<AgentAttentionFallbackEventDetail>(
      OPCODE_AGENT_ATTENTION_FALLBACK_EVENT,
      {
        detail: fallbackDetail,
      }
    )
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
    focusTrackingInFlight = false;
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

  const deliveryStatus: AgentAttentionDeliveryStatus = {
    desktopAttempted: false,
    desktopDelivered: false,
    fallbackDispatched: false,
  };

  dispatchAttentionEvent(detail);

  if (!windowFocused) {
    unreadBadgeCount += 1;
    await setBadgeCountSafely(unreadBadgeCount);
  }

  const desktopResult = await maybeShowDesktopNotification(detail);
  deliveryStatus.desktopAttempted = desktopResult.attempted;
  deliveryStatus.desktopDelivered = desktopResult.delivered;

  if (!windowFocused && !desktopResult.delivered) {
    dispatchAttentionFallbackEvent(detail);
    deliveryStatus.fallbackDispatched = true;
  }

  void deliveryStatus;
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
  if (typeof value.prompt === "string") {
    parts.push(value.prompt);
  }
  if (typeof value.question === "string") {
    parts.push(value.question);
  }

  if (Array.isArray(value.questions)) {
    value.questions.forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const questionRecord = entry as Record<string, unknown>;
      if (typeof questionRecord.question === "string") {
        parts.push(questionRecord.question);
      }
      if (typeof questionRecord.description === "string") {
        parts.push(questionRecord.description);
      }
      if (typeof questionRecord.header === "string") {
        parts.push(questionRecord.header);
      }
    });
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

function hasNeedsInputToolSignal(
  value: unknown,
  seen = new Set<object>()
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) {
    return false;
  }
  seen.add(objectValue);

  const type =
    typeof objectValue.type === "string" ? objectValue.type.toLowerCase() : "";
  const name =
    typeof objectValue.name === "string" ? objectValue.name.toLowerCase() : "";
  const recipientName =
    typeof objectValue.recipient_name === "string"
      ? objectValue.recipient_name.toLowerCase()
      : "";
  const command =
    typeof objectValue.command === "string"
      ? objectValue.command.toLowerCase()
      : "";
  const tool =
    typeof objectValue.tool === "string" ? objectValue.tool.toLowerCase() : "";

  const combinedLabels = [type, name, recipientName, command, tool].join(" ");
  if (combinedLabels.includes("request_user_input")) {
    return true;
  }

  const nestedCandidates: unknown[] = [
    objectValue.content,
    objectValue.message,
    objectValue.item,
    objectValue.input,
    objectValue.output,
    objectValue.payload,
    objectValue.detail,
    objectValue.arguments,
    objectValue.args,
    objectValue.questions,
  ];

  for (const candidate of nestedCandidates) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (hasNeedsInputToolSignal(entry, seen)) {
          return true;
        }
      }
      continue;
    }
    if (hasNeedsInputToolSignal(candidate, seen)) {
      return true;
    }
  }

  return false;
}

export function shouldTriggerNeedsInputFromMessage(message: unknown): boolean {
  if (hasNeedsInputToolSignal(message)) {
    return true;
  }
  return shouldTriggerNeedsInput(extractAttentionText(message));
}

export function summarizeAttentionBody(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "";
  }
  return truncate(normalized, 160);
}
