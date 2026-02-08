import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sentPayloads: string[] = [];
  send = vi.fn((payload: string) => {
    this.sentPayloads.push(payload);
  });
  close = vi.fn((code?: number, reason?: string) => {
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  emitOpen() {
    this.onopen?.({} as Event);
  }

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError() {
    this.onerror?.({} as Event);
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

async function loadApiAdapter() {
  vi.resetModules();
  return import("./apiAdapter");
}

describe("apiAdapter provider-session mappings", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (window as any).__TAURI__ = undefined;
    (window as any).__TAURI_METADATA__ = undefined;
    (window as any).__TAURI_INTERNALS__ = undefined;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps list_running_provider_sessions to /api/provider-sessions/running", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [{ id: "run-1" }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { apiCall } = await loadApiAdapter();
    const result = await apiCall<Array<{ id: string }>>("list_running_provider_sessions");

    expect(result).toEqual([{ id: "run-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/provider-sessions/running");
  });

  it("maps cancel_provider_session with encoded sessionId path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: null }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { apiCall } = await loadApiAdapter();
    await apiCall("cancel_provider_session", { sessionId: "abc/123" });

    const requestUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestUrl).toContain("/api/provider-sessions/abc%2F123/cancel");
    expect(requestUrl).not.toContain("sessionId=");
  });

  it("uses /ws/provider-session and dispatches generic + scoped output/complete events", async () => {
    const { apiCall } = await loadApiAdapter();
    const outputEvents: unknown[] = [];
    const scopedOutputEvents: unknown[] = [];
    const completeEvents: unknown[] = [];
    const scopedCompleteEvents: unknown[] = [];
    const legacyOutputEvents: unknown[] = [];

    window.addEventListener("provider-session-output", (event) => {
      outputEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-output:session-123", (event) => {
      scopedOutputEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-complete", (event) => {
      completeEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-complete:session-123", (event) => {
      scopedCompleteEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("claude-output", (event) => {
      legacyOutputEvents.push((event as CustomEvent).detail);
    });

    const callPromise = apiCall("execute_provider_session", {
      projectPath: "/tmp/project",
      prompt: "Ship it",
      model: "sonnet",
      sessionId: "session-123",
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toContain("/ws/provider-session");

    socket.emitOpen();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      command_type: "execute",
      project_path: "/tmp/project",
      prompt: "Ship it",
      model: "sonnet",
      session_id: "session-123",
    });

    const streamMessage = { type: "assistant", session_id: "session-123" };
    socket.emitMessage(
      JSON.stringify({
        type: "output",
        content: JSON.stringify(streamMessage),
      })
    );
    socket.emitMessage(JSON.stringify({ type: "completion", status: "success" }));

    await expect(callPromise).resolves.toEqual({});
    expect(outputEvents).toEqual([streamMessage]);
    expect(scopedOutputEvents).toEqual([streamMessage]);
    expect(completeEvents).toEqual([
      { status: "success", success: true, sessionId: "session-123" },
    ]);
    expect(scopedCompleteEvents).toEqual([
      { status: "success", success: true, sessionId: "session-123" },
    ]);
    expect(legacyOutputEvents).toHaveLength(0);
  });

  it("dispatches provider-session-error on websocket error messages", async () => {
    const { apiCall } = await loadApiAdapter();
    const errorEvents: unknown[] = [];

    window.addEventListener("provider-session-error", (event) => {
      errorEvents.push((event as CustomEvent).detail);
    });

    const callPromise = apiCall("execute_provider_session", {
      projectPath: "/tmp/project",
      prompt: "Retry",
      model: "sonnet",
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage(JSON.stringify({ type: "error", message: "stream failed" }));

    await expect(callPromise).rejects.toThrow("stream failed");
    expect(errorEvents).toEqual(["stream failed"]);
  });

  it("dispatches provider-session-cancelled events for cancelled completion", async () => {
    const { apiCall } = await loadApiAdapter();
    const cancelledEvents: unknown[] = [];
    const scopedCancelledEvents: unknown[] = [];
    const completeEvents: unknown[] = [];

    window.addEventListener("provider-session-cancelled", (event) => {
      cancelledEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-cancelled:session-123", (event) => {
      scopedCancelledEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-complete", (event) => {
      completeEvents.push((event as CustomEvent).detail);
    });

    const callPromise = apiCall("execute_provider_session", {
      projectPath: "/tmp/project",
      prompt: "Cancel",
      model: "sonnet",
      sessionId: "session-123",
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage(JSON.stringify({ type: "completion", status: "cancelled" }));

    await expect(callPromise).rejects.toThrow("Execution cancelled");
    expect(cancelledEvents).toEqual([true]);
    expect(scopedCancelledEvents).toEqual([true]);
    expect(completeEvents).toEqual([
      { status: "cancelled", success: false, sessionId: "session-123" },
    ]);
  });

  it("switches scoped events to streamed session_id when it differs from the request", async () => {
    const { apiCall } = await loadApiAdapter();
    const requestScopedOutputEvents: unknown[] = [];
    const streamedScopedOutputEvents: unknown[] = [];
    const streamedScopedCompleteEvents: unknown[] = [];

    window.addEventListener("provider-session-output:resume-seed-id", (event) => {
      requestScopedOutputEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-output:runtime-session-456", (event) => {
      streamedScopedOutputEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-complete:runtime-session-456", (event) => {
      streamedScopedCompleteEvents.push((event as CustomEvent).detail);
    });

    const callPromise = apiCall("resume_provider_session", {
      projectPath: "/tmp/project",
      prompt: "Resume with remap",
      model: "sonnet",
      sessionId: "resume-seed-id",
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        type: "output",
        content: JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "runtime-session-456",
        }),
      })
    );
    socket.emitMessage(
      JSON.stringify({
        type: "output",
        content: JSON.stringify({
          type: "assistant",
          session_id: "runtime-session-456",
        }),
      })
    );
    socket.emitMessage(JSON.stringify({ type: "completion", status: "success" }));

    await expect(callPromise).resolves.toEqual({});
    expect(requestScopedOutputEvents).toHaveLength(0);
    expect(streamedScopedOutputEvents).toHaveLength(2);
    expect(streamedScopedCompleteEvents).toEqual([
      { status: "success", success: true, sessionId: "runtime-session-456" },
    ]);
  });

  it("dispatches provider-session-cancelled on abnormal websocket close", async () => {
    const { apiCall } = await loadApiAdapter();
    const cancelledEvents: unknown[] = [];
    const scopedCancelledEvents: unknown[] = [];
    const completeEvents: unknown[] = [];

    window.addEventListener("provider-session-cancelled", (event) => {
      cancelledEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-cancelled:session-abc", (event) => {
      scopedCancelledEvents.push((event as CustomEvent).detail);
    });
    window.addEventListener("provider-session-complete", (event) => {
      completeEvents.push((event as CustomEvent).detail);
    });

    const callPromise = apiCall("execute_provider_session", {
      projectPath: "/tmp/project",
      prompt: "Disconnect",
      model: "sonnet",
      sessionId: "session-abc",
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    socket.close(1006, "abnormal close");

    await expect(callPromise).rejects.toThrow(
      "Execution cancelled: WebSocket connection closed unexpectedly"
    );
    expect(cancelledEvents).toEqual([true]);
    expect(scopedCancelledEvents).toEqual([true]);
    expect(completeEvents).toEqual([
      {
        status: "cancelled",
        success: false,
        error: "Execution cancelled: WebSocket connection closed unexpectedly",
        sessionId: "session-abc",
      },
    ]);
  });
});
