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

  it("resets unread badge count when focus returns", async () => {
    mockState.isFocusedValue = false;

    const { initAgentAttention, emitAgentAttention, OPCODE_AGENT_ATTENTION_EVENT } =
      await loadService();
    const cleanup = initAgentAttention();

    const dispatched: AgentAttentionEventDetail[] = [];
    const onAttention = (event: Event) => {
      dispatched.push((event as CustomEvent<AgentAttentionEventDetail>).detail);
    };
    window.addEventListener(OPCODE_AGENT_ATTENTION_EVENT, onAttention as EventListener);

    await emitAttentionWithDefaults(emitAgentAttention, "First badge increment body.");
    await emitAttentionWithDefaults(emitAgentAttention, "Second badge increment body.");

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

    window.removeEventListener(OPCODE_AGENT_ATTENTION_EVENT, onAttention as EventListener);
    cleanup();
  });
});
