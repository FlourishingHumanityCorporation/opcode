import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAttentionEventDetail } from "@/services/agentAttention";

type FocusChangedHandler = (event: { payload: boolean }) => void;

const mockState = vi.hoisted(() => ({
  isFocusedValue: true,
  focusChangedHandler: null as FocusChangedHandler | null,
}));

const mockFns = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
  isFocused: vi.fn(),
  onFocusChanged: vi.fn(),
  setBadgeCount: vi.fn(),
  unlisten: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mockFns.getCurrentWindow,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mockFns.isPermissionGranted,
  requestPermission: mockFns.requestPermission,
  sendNotification: mockFns.sendNotification,
}));

vi.mock("@/services/notificationHistory", () => ({
  notificationHistory: {
    add: vi.fn(),
    getAll: () => [],
    getUnread: () => [],
    getUnreadCount: () => 0,
    markAllRead: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("@/services/notificationSound", () => ({
  playNotificationSound: vi.fn(),
}));

vi.mock("@/lib/notificationPreferences", () => ({
  readNotificationPreferencesFromStorage: vi.fn(() => ({
    enabled_done: true,
    enabled_needs_input: true,
    sound_enabled: false,
    sound_kind: "needs_input_only",
  })),
}));

async function loadService() {
  return import("@/services/agentAttention");
}

async function emitAttentionWithDefaults(
  emitAgentAttention: (input: {
    kind: "done" | "needs_input";
    workspaceId?: string;
    terminalTabId?: string;
    source: "provider_session" | "agent_execution" | "agent_run_output";
    title?: string;
    body?: string;
  }) => Promise<boolean>,
  body: string,
  kind: "done" | "needs_input" = "done",
  terminalTabId = "terminal-1"
) {
  return emitAgentAttention({
    kind,
    workspaceId: "workspace-1",
    terminalTabId,
    source: "provider_session",
    body,
  });
}

describe("agentAttention notifications and badge behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockState.isFocusedValue = true;
    mockState.focusChangedHandler = null;

    mockFns.isFocused.mockImplementation(async () => mockState.isFocusedValue);
    mockFns.onFocusChanged.mockImplementation(async (handler: FocusChangedHandler) => {
      mockState.focusChangedHandler = handler;
      return mockFns.unlisten;
    });
    mockFns.getCurrentWindow.mockImplementation(() => ({
      isFocused: mockFns.isFocused,
      onFocusChanged: mockFns.onFocusChanged,
      setBadgeCount: mockFns.setBadgeCount,
    }));

    mockFns.isPermissionGranted.mockResolvedValue(true);
    mockFns.requestPermission.mockResolvedValue("granted");

    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("does not send desktop notifications while window is focused", async () => {
    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const emitted = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Focused window should suppress desktop notifications."
    );

    expect(emitted).toBe(true);
    expect(mockFns.sendNotification).not.toHaveBeenCalled();
    expect(mockFns.setBadgeCount).not.toHaveBeenCalled();

    cleanup();
  });

  it("sends desktop notifications and increments badge when unfocused", async () => {
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const emitted = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Unfocused run complete should notify."
    );

    expect(emitted).toBe(true);
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockFns.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Agent done",
      })
    );
    expect(mockFns.setBadgeCount).toHaveBeenCalledWith(1);

    cleanup();
  });

  it("still attempts desktop notifications when bridge globals are absent", async () => {
    mockState.isFocusedValue = false;
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_METADATA__;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const emitted = await emitAttentionWithDefaults(
      emitAgentAttention,
      "No bridge globals should still allow desktop notifications."
    );

    expect(emitted).toBe(true);
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockFns.setBadgeCount).toHaveBeenCalledWith(1);

    cleanup();
  });

  it("requests permission once and only notifies when granted", async () => {
    mockState.isFocusedValue = false;
    mockFns.isPermissionGranted.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockFns.requestPermission.mockResolvedValueOnce("granted");

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const first = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Needs approval before command execution.",
      "needs_input"
    );
    const second = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Second distinct body to avoid dedupe.",
      "done"
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockFns.requestPermission).toHaveBeenCalledTimes(1);
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("dedupes repeated needs_input alerts from stream chunks", async () => {
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const first = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Please confirm before I proceed with this step.",
      "needs_input",
      "terminal-42"
    );
    const second = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Please confirm before I proceed with this step.",
      "needs_input",
      "terminal-42"
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockFns.setBadgeCount).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("dispatches fallback attention event when desktop notification is unavailable", async () => {
    mockState.isFocusedValue = false;
    mockFns.isPermissionGranted.mockResolvedValue(false);
    mockFns.requestPermission.mockResolvedValue("denied");

    const {
      initAgentAttention,
      emitAgentAttention,
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
    } = await loadService();
    const cleanup = initAgentAttention();

    const fallbackEvents: Array<Record<string, unknown>> = [];
    const onFallback = (event: Event) => {
      fallbackEvents.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener(
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
      onFallback as EventListener
    );

    const emitted = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Fallback should emit when permission remains denied."
    );

    expect(emitted).toBe(true);
    expect(mockFns.sendNotification).not.toHaveBeenCalled();
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toEqual(
      expect.objectContaining({
        kind: "done",
        source: "provider_session",
        terminalTabId: "terminal-1",
      })
    );

    window.removeEventListener(
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
      onFallback as EventListener
    );
    cleanup();
  });

  it("dispatches fallback attention event when desktop notification throws", async () => {
    mockState.isFocusedValue = false;
    mockFns.isPermissionGranted.mockResolvedValue(true);
    mockFns.sendNotification.mockRejectedValue(new Error("notification failure"));

    const {
      initAgentAttention,
      emitAgentAttention,
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
    } = await loadService();
    const cleanup = initAgentAttention();

    const fallbackEvents: Array<Record<string, unknown>> = [];
    const onFallback = (event: Event) => {
      fallbackEvents.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener(
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
      onFallback as EventListener
    );

    const emitted = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Fallback should emit when notification send throws."
    );

    expect(emitted).toBe(true);
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toEqual(
      expect.objectContaining({
        kind: "done",
        source: "provider_session",
      })
    );

    window.removeEventListener(
      CODEINTERFACEX_AGENT_ATTENTION_FALLBACK_EVENT,
      onFallback as EventListener
    );
    cleanup();
  });

  it("allows identical deduped events again after dedupe window expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const first = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Build completed.",
      "done",
      "terminal-dedupe"
    );
    const second = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Build completed.",
      "done",
      "terminal-dedupe"
    );

    vi.advanceTimersByTime(4501);

    const third = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Build completed.",
      "done",
      "terminal-dedupe"
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
    cleanup();
  });

  it("throttles needs_input on same terminal across different bodies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const first = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Please confirm deployment plan A.",
      "needs_input",
      "terminal-throttle"
    );
    vi.advanceTimersByTime(5000);
    const second = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Please confirm deployment plan B.",
      "needs_input",
      "terminal-throttle"
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    cleanup();
  });

  it("does not throttle needs_input across different terminals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention } = await loadService();
    const cleanup = initAgentAttention();

    const first = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Approve terminal A action.",
      "needs_input",
      "terminal-a"
    );
    vi.advanceTimersByTime(1000);
    const second = await emitAttentionWithDefaults(
      emitAgentAttention,
      "Approve terminal B action.",
      "needs_input",
      "terminal-b"
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    cleanup();
  });

  it("resets unread badge count when focus returns", async () => {
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } =
      await loadService();
    const cleanup = initAgentAttention();

    const dispatched: AgentAttentionEventDetail[] = [];
    const onAttention = (event: Event) => {
      dispatched.push((event as CustomEvent<AgentAttentionEventDetail>).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);

    // Use different sources to avoid batch consolidation
    await emitAgentAttention({
      kind: "done",
      workspaceId: "workspace-1",
      terminalTabId: "terminal-1",
      source: "provider_session",
      body: "First badge increment body.",
    });
    await emitAgentAttention({
      kind: "done",
      workspaceId: "workspace-1",
      terminalTabId: "terminal-1",
      source: "agent_execution",
      body: "Second badge increment body.",
    });

    expect(mockFns.setBadgeCount).toHaveBeenCalledWith(1);
    expect(mockFns.setBadgeCount).toHaveBeenCalledWith(2);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.source).toBe("provider_session");

    mockState.focusChangedHandler?.({ payload: true });
    await Promise.resolve();

    const hasBadgeResetCall = mockFns.setBadgeCount.mock.calls.some(
      (args) => args.length === 0
    );
    expect(hasBadgeResetCall).toBe(true);

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);
    cleanup();
  });
});
