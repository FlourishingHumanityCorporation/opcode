import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("agentAttention focus context", () => {
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

    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("computeFocusContext returns 'same_tab' when no provider is set", async () => {
    const { initAgentAttention, computeFocusContext } = await loadService();
    const cleanup = initAgentAttention();

    const result = computeFocusContext({
      kind: "done",
      source: "provider_session",
      title: "Test",
      body: "Test",
      timestamp: Date.now(),
    });

    expect(result).toBe("same_tab");
    cleanup();
  });

  it("computeFocusContext returns 'same_tab' when terminal tab matches", async () => {
    const { initAgentAttention, computeFocusContext, setActiveTabProvider } = await loadService();
    const cleanup = initAgentAttention();

    setActiveTabProvider(() => ({
      activeWorkspaceId: "ws-1",
      activeTerminalTabId: "term-1",
    }));

    const result = computeFocusContext({
      kind: "done",
      source: "provider_session",
      title: "Test",
      body: "Test",
      terminalTabId: "term-1",
      timestamp: Date.now(),
    });

    expect(result).toBe("same_tab");
    cleanup();
  });

  it("computeFocusContext returns 'different_tab' when terminal tab differs", async () => {
    const { initAgentAttention, computeFocusContext, setActiveTabProvider } = await loadService();
    const cleanup = initAgentAttention();

    setActiveTabProvider(() => ({
      activeWorkspaceId: "ws-1",
      activeTerminalTabId: "term-1",
    }));

    const result = computeFocusContext({
      kind: "done",
      source: "provider_session",
      title: "Test",
      body: "Test",
      terminalTabId: "term-2",
      timestamp: Date.now(),
    });

    expect(result).toBe("different_tab");
    cleanup();
  });

  it("computeFocusContext returns 'unfocused' when window is not focused", async () => {
    mockState.isFocusedValue = false;
    const { initAgentAttention, emitAgentAttention, computeFocusContext, setActiveTabProvider } = await loadService();
    const cleanup = initAgentAttention();

    // Trigger ensureFocusTracking so windowFocused picks up the mock value
    await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "warm up",
    });

    setActiveTabProvider(() => ({
      activeWorkspaceId: "ws-1",
      activeTerminalTabId: "term-1",
    }));

    const result = computeFocusContext({
      kind: "done",
      source: "provider_session",
      title: "Test",
      body: "Test",
      terminalTabId: "term-1",
      timestamp: Date.now(),
    });

    expect(result).toBe("unfocused");
    cleanup();
  });

  it("running kind dispatches DOM event but skips notification pipeline", async () => {
    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } = await loadService();
    const cleanup = initAgentAttention();

    const dispatched: unknown[] = [];
    const onAttention = (event: Event) => {
      dispatched.push((event as CustomEvent).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);

    const result = await emitAgentAttention({
      kind: "running",
      source: "provider_session",
      body: "Processing...",
    });

    expect(result).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(mockFns.sendNotification).not.toHaveBeenCalled();
    expect(mockFns.setBadgeCount).not.toHaveBeenCalled();

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);
    cleanup();
  });

  it("preference gating suppresses OS notification but still dispatches DOM event", async () => {
    const { readNotificationPreferencesFromStorage } = await import("@/lib/notificationPreferences");
    (readNotificationPreferencesFromStorage as ReturnType<typeof vi.fn>).mockReturnValue({
      enabled_done: false,
      enabled_needs_input: true,
      sound_enabled: false,
      sound_kind: "needs_input_only",
    });

    mockState.isFocusedValue = false;
    const { initAgentAttention, emitAgentAttention, CODEINTERFACEX_AGENT_ATTENTION_EVENT } = await loadService();
    const cleanup = initAgentAttention();

    const dispatched: unknown[] = [];
    const onAttention = (event: Event) => {
      dispatched.push((event as CustomEvent).detail);
    };
    window.addEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);

    const result = await emitAgentAttention({
      kind: "done",
      source: "provider_session",
      body: "This should be suppressed by prefs",
    });

    expect(result).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(mockFns.sendNotification).not.toHaveBeenCalled();

    window.removeEventListener(CODEINTERFACEX_AGENT_ATTENTION_EVENT, onAttention as EventListener);
    cleanup();
  });

  it("setActiveTabProvider callback is called during focus context computation", async () => {
    const { initAgentAttention, computeFocusContext, setActiveTabProvider } = await loadService();
    const cleanup = initAgentAttention();

    const providerFn = vi.fn(() => ({
      activeWorkspaceId: "ws-1",
      activeTerminalTabId: "term-1",
    }));
    setActiveTabProvider(providerFn);

    computeFocusContext({
      kind: "done",
      source: "provider_session",
      title: "Test",
      body: "Test",
      timestamp: Date.now(),
    });

    expect(providerFn).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
