import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAttentionEventDetail } from "@/services/agentAttention";

type FocusChangedHandler = (event: { payload: boolean }) => void;

const mockState = vi.hoisted(() => ({
  isFocusedValue: false,
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

describe("agentAttention batch consolidation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockState.isFocusedValue = false;
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

    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("first event dispatches immediately, not batched", async () => {
    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } = await loadService();
    const cleanup = initAgentAttention();

    const dispatched: AgentAttentionEventDetail[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<AgentAttentionEventDetail>).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);

    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "First event",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].body).toBe("First event");

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);
    cleanup();
  });

  it("consolidates 3 events within batch window — batches OS notifications", async () => {
    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } = await loadService();
    const cleanup = initAgentAttention();

    const dispatched: AgentAttentionEventDetail[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<AgentAttentionEventDetail>).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);

    // First event dispatches immediately (DOM + OS notification)
    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "Event 1",
    });

    // Second and third: DOM events fire (for tab badges), but OS notification is batched
    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "Event 2",
    });
    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "Event 3",
    });

    // All 3 DOM events fire immediately (tab badges need them)
    expect(dispatched).toHaveLength(3);
    // But only first event triggered OS notification so far
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(1);

    // Flush the batch timer
    vi.advanceTimersByTime(2100);
    await vi.runAllTimersAsync();

    // Consolidated DOM event fires from batch flush
    expect(dispatched).toHaveLength(4);
    expect(dispatched[3].title).toContain("3");
    expect(dispatched[3].title).toContain("runs completed");
    // Consolidated OS notification also fires
    expect(mockFns.sendNotification).toHaveBeenCalledTimes(2);

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);
    cleanup();
  });

  it("events after batch window are independent", async () => {
    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } = await loadService();
    const cleanup = initAgentAttention();

    const dispatched: AgentAttentionEventDetail[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<AgentAttentionEventDetail>).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);

    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "First event",
    });

    // Flush batch and wait for window to close
    vi.advanceTimersByTime(2100);
    await vi.runAllTimersAsync();

    // Wait past dedupe window too
    vi.advanceTimersByTime(4600);

    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "Second event after window",
    });

    // Both should dispatch independently (first + flush had only 1 event so no consolidated)
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].body).toBe("Second event after window");

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, handler as EventListener);
    cleanup();
  });
});
