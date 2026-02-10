import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from '@/lib/logger';
import { readNotificationPreferencesFromStorage } from "@/lib/notificationPreferences";
import { notificationHistory } from "@/services/notificationHistory";
import { playNotificationSound } from "@/services/notificationSound";

export const CODEINTERFACEX_AGENT_ATTENTION_EVENT = "codeinterfacex-agent-attention";
export const CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT =
  "codeinterfacex-agent-attention-fallback";

export type AgentAttentionKind = "done" | "needs_input" | "running";
export type AgentAttentionSource =
  | "provider_session"
  | "agent_execution"
  | "agent_run_output";

export type FocusContext = "same_tab" | "different_tab" | "unfocused";

export type ActiveTabProvider = () => {
  activeWorkspaceId: string | null;
  activeTerminalTabId: string | null;
} | null;

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

export interface AgentAttentionFallbackToastDetail {
  message: string;
  type: "success" | "info";
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
const BATCH_WINDOW_MS = 2000;

const genericDedupeByKey = new Map<string, number>();
const needsInputByTerminal = new Map<string, number>();

let focusTrackingReady = false;
let focusTrackingInFlight = false;
let focusListenerUnlisten: (() => void) | null = null;
let focusListenerRefCount = 0;
let windowFocused = true;
let unreadBadgeCount = 0;
let notificationPermissionRequested = false;
let activeTabProvider: ActiveTabProvider | null = null;

interface PendingBatch {
  events: AgentAttentionEventDetail[];
  timer: ReturnType<typeof setTimeout>;
}

const pendingBatch = new Map<string, PendingBatch>();

export function setActiveTabProvider(provider: ActiveTabProvider): void {
  activeTabProvider = provider;
}

export function computeFocusContext(detail: AgentAttentionEventDetail): FocusContext {
  if (!windowFocused) return "unfocused";
  const ctx = activeTabProvider?.();
  if (!ctx) return "same_tab";
  if (
    detail.terminalTabId &&
    ctx.activeTerminalTabId === detail.terminalTabId
  ) {
    return "same_tab";
  }
  if (
    detail.workspaceId &&
    ctx.activeWorkspaceId === detail.workspaceId &&
    !detail.terminalTabId
  ) {
    return "same_tab";
  }
  return "different_tab";
}

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
  if (kind === "running") return "Agent running";
  return kind === "done" ? "Agent done" : "Agent needs input";
}

function defaultBodyForKind(kind: AgentAttentionKind): string {
  if (kind === "done") {
    return "A run completed successfully.";
  }
  if (kind === "running") {
    return "Processing...";
  }
  return "The agent is waiting for your approval or decision.";
}

function isKindEnabledByPreferences(kind: AgentAttentionKind): boolean {
  if (kind === "running") return true;
  const prefs = readNotificationPreferencesFromStorage();
  if (kind === "done") return prefs.enabled_done;
  if (kind === "needs_input") return prefs.enabled_needs_input;
  return true;
}

export function mapAgentAttentionFallbackToToast(
  detail: AgentAttentionFallbackEventDetail | null | undefined
): AgentAttentionFallbackToastDetail {
  const kind: AgentAttentionKind = detail?.kind === "needs_input" ? "needs_input" : "done";
  const normalizedBody = normalizeWhitespace(typeof detail?.body === "string" ? detail.body : "");
  return {
    message: normalizedBody || defaultBodyForKind(kind),
    type: kind === "needs_input" ? "info" : "success",
  };
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
    logger.warn('misc', '[agentAttention] Failed to set badge count:', { value: error });
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
    logger.warn('misc', '[agentAttention] Failed to send desktop notification:', { value: error });
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
    logger.warn('misc', '[agentAttention] Failed to initialize focus tracking:', { value: error });
  } finally {
    focusTrackingInFlight = false;
  }
}

function dispatchAttentionEvent(detail: AgentAttentionEventDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AgentAttentionEventDetail>(CODEINTERFACEX_AGENT_ATTENTION_EVENT, {
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
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
      {
        detail: fallbackDetail,
      }
    )
  );
}

function createConsolidatedPayload(
  events: AgentAttentionEventDetail[]
): AgentAttentionEventDetail {
  const first = events[0];
  const count = events.length;
  const kindLabel = first.kind === "done" ? "runs completed" : "inputs needed";
  return {
    kind: first.kind,
    source: first.source,
    title: `${count} ${kindLabel}`,
    body: `${count} ${kindLabel} while batching.`,
    timestamp: Date.now(),
  };
}

function flushBatch(key: string): void {
  const batch = pendingBatch.get(key);
  pendingBatch.delete(key);
  if (!batch || batch.events.length <= 1) return;

  const consolidated = createConsolidatedPayload(batch.events);
  const focusCtx = computeFocusContext(consolidated);

  dispatchAttentionEvent(consolidated);

  notificationHistory.add({
    id: crypto.randomUUID(),
    kind: consolidated.kind,
    source: consolidated.source,
    title: consolidated.title,
    body: consolidated.body,
    focusContext: focusCtx,
    timestamp: consolidated.timestamp,
    read: focusCtx === "same_tab",
  });

  if (focusCtx === "unfocused") {
    unreadBadgeCount += 1;
    void setBadgeCountSafely(unreadBadgeCount);
    void maybeShowDesktopNotification(consolidated).then((result) => {
      if (!result.delivered) {
        dispatchAttentionFallbackEvent(consolidated);
      }
    });
    void playNotificationSound(consolidated.kind);
  }
}

function tryBatch(detail: AgentAttentionEventDetail): boolean {
  const key = `${detail.kind}|${detail.source}`;
  const existing = pendingBatch.get(key);
  if (existing) {
    existing.events.push(detail);
    return true;
  }
  const batch: PendingBatch = {
    events: [detail],
    timer: setTimeout(() => flushBatch(key), BATCH_WINDOW_MS),
  };
  pendingBatch.set(key, batch);
  return false;
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
    activeTabProvider = null;
    for (const [, batch] of pendingBatch) {
      clearTimeout(batch.timer);
    }
    pendingBatch.clear();
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

  // Running kind: always dispatch DOM event for tab UI, skip everything else
  if (detail.kind === "running") {
    if (shouldSuppress(detail)) return false;
    dispatchAttentionEvent(detail);
    return true;
  }

  // Check user preference gating
  if (!isKindEnabledByPreferences(detail.kind)) {
    // Still dispatch DOM event so tab badges update
    dispatchAttentionEvent(detail);
    return true;
  }

  if (shouldSuppress(detail)) {
    return false;
  }

  const focusCtx = computeFocusContext(detail);

  // Always dispatch DOM event (tab badges need it regardless of focus)
  dispatchAttentionEvent(detail);

  // Record in notification history
  notificationHistory.add({
    id: crypto.randomUUID(),
    kind: detail.kind,
    source: detail.source,
    title: detail.title,
    body: detail.body,
    terminalTabId: detail.terminalTabId,
    focusContext: focusCtx,
    timestamp: detail.timestamp,
    read: focusCtx === "same_tab",
  });

  // same_tab: no OS notification, no badge, no sound
  if (focusCtx === "same_tab") {
    return true;
  }

  // different_tab: badge only (no OS notification, no toast, no sound)
  if (focusCtx === "different_tab") {
    return true;
  }

  // unfocused: full notification pipeline with batching
  if (tryBatch(detail)) {
    // Absorbed into existing batch — will consolidate on flush
    return true;
  }

  const deliveryStatus: AgentAttentionDeliveryStatus = {
    desktopAttempted: false,
    desktopDelivered: false,
    fallbackDispatched: false,
  };

  unreadBadgeCount += 1;
  await setBadgeCountSafely(unreadBadgeCount);

  const desktopResult = await maybeShowDesktopNotification(detail);
  deliveryStatus.desktopAttempted = desktopResult.attempted;
  deliveryStatus.desktopDelivered = desktopResult.delivered;

  if (!desktopResult.delivered) {
    dispatchAttentionFallbackEvent(detail);
    deliveryStatus.fallbackDispatched = true;
  }

  void playNotificationSound(detail.kind);

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

function hasAskUserQuestionToolSignal(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return false;
  seen.add(obj);

  const tool = typeof obj.tool === "string" ? obj.tool : "";
  const name = typeof obj.name === "string" ? obj.name : "";
  if (tool === "AskUserQuestion" || name === "AskUserQuestion") {
    return true;
  }

  const candidates: unknown[] = [
    obj.content, obj.message, obj.item, obj.payload,
    obj.tool_uses, obj.tools,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (hasAskUserQuestionToolSignal(entry, seen)) return true;
      }
      continue;
    }
    if (hasAskUserQuestionToolSignal(candidate, seen)) return true;
  }
  return false;
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
    objectValue.tool_uses,
    objectValue.tools,
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
  if (hasAskUserQuestionToolSignal(message)) {
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
