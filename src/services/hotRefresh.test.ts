import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriListeners = vi.hoisted(() => new Map<string, (event: any) => void>());
const apiMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
  hotRefreshStart: vi.fn(),
  hotRefreshStop: vi.fn(),
  hotRefreshUpdatePaths: vi.fn(),
}));
const tauriEventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriEventMocks.listen,
  emit: tauriEventMocks.emit,
}));

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();

  name: string;
  onmessage: ((event: MessageEvent<any>) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)?.add(this);
  }

  postMessage(data: any) {
    const peers = MockBroadcastChannel.channels.get(this.name) ?? new Set();
    peers.forEach((channel) => {
      if (channel === this) {
        return;
      }
      channel.onmessage?.({ data } as MessageEvent<any>);
    });
  }

  close() {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset() {
    MockBroadcastChannel.channels.clear();
  }
}

type HotRuntimeWithTrigger = {
  on: (event: string, callback: (payload: unknown) => void) => void;
  off: (event: string, callback: (payload: unknown) => void) => void;
  trigger: (event: string, payload?: unknown) => void;
};

function createHotRuntime(): HotRuntimeWithTrigger {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();

  return {
    on(event, callback) {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)?.add(callback);
    },
    off(event, callback) {
      handlers.get(event)?.delete(callback);
    },
    trigger(event, payload) {
      handlers.get(event)?.forEach((handler) => handler(payload));
    },
  };
}

function setupDefaultSettingMocks() {
  apiMocks.getSetting.mockImplementation(async (key: string) => {
    if (key === "hot_refresh_enabled") return "true";
    if (key === "hot_refresh_scope") return "all";
    if (key === "hot_refresh_watch_paths") return JSON.stringify(["src"]);
    return null;
  });
  apiMocks.saveSetting.mockResolvedValue(undefined);
  apiMocks.hotRefreshStart.mockResolvedValue(undefined);
  apiMocks.hotRefreshStop.mockResolvedValue(undefined);
  apiMocks.hotRefreshUpdatePaths.mockResolvedValue(undefined);
}

describe("hotRefresh service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-09T10:00:00.000Z"));

    tauriListeners.clear();
    tauriEventMocks.listen.mockReset();
    tauriEventMocks.emit.mockReset();
    tauriEventMocks.listen.mockImplementation(async (eventName: string, callback: (event: any) => void) => {
      tauriListeners.set(eventName, callback);
      return () => {
        tauriListeners.delete(eventName);
      };
    });

    setupDefaultSettingMocks();
    MockBroadcastChannel.reset();
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
    delete (globalThis as any).__OPCODE_HOT_RUNTIME__;
  });

  afterEach(async () => {
    const module = await import("@/services/hotRefresh");
    module.__resetHotRefreshForTests();

    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    MockBroadcastChannel.reset();
    delete (globalThis as any).BroadcastChannel;
    delete (globalThis as any).__OPCODE_HOT_RUNTIME__;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("does not hard-reload when HMR settles successfully", async () => {
    const hotRuntime = createHotRuntime();
    (globalThis as any).__OPCODE_HOT_RUNTIME__ = hotRuntime;

    const module = await import("@/services/hotRefresh");
    const reloadSpy = vi.fn();
    module.__setHotRefreshReloadForTests(reloadSpy);

    const teardown = await module.initHotRefresh();

    hotRuntime.trigger("vite:beforeUpdate");
    hotRuntime.trigger("vite:afterUpdate");
    vi.advanceTimersByTime(2_000);

    expect(reloadSpy).not.toHaveBeenCalled();

    teardown();
  });

  it("forces hard reload when HMR does not settle before timeout", async () => {
    const hotRuntime = createHotRuntime();
    (globalThis as any).__OPCODE_HOT_RUNTIME__ = hotRuntime;

    const module = await import("@/services/hotRefresh");
    const reloadSpy = vi.fn();
    module.__setHotRefreshReloadForTests(reloadSpy);

    const teardown = await module.initHotRefresh();

    hotRuntime.trigger("vite:beforeUpdate");
    vi.advanceTimersByTime(1_600);
    vi.advanceTimersByTime(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("reloads when backend hot-refresh file change event arrives", async () => {
    (window as any).__TAURI_INTERNALS__ = {};

    const module = await import("@/services/hotRefresh");
    const reloadSpy = vi.fn();
    module.__setHotRefreshReloadForTests(reloadSpy);

    const teardown = await module.initHotRefresh();

    const callback = tauriListeners.get(module.OPCODE_HOT_REFRESH_BACKEND_EVENT);
    expect(callback).toBeTypeOf("function");

    callback?.({ payload: { path: "src/App.tsx" } });
    vi.advanceTimersByTime(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    teardown();
  });

  it("ignores web-mode __TAURI__ shim when real desktop internals are absent", async () => {
    (window as any).__TAURI__ = {
      event: {
        listen: vi.fn(),
        emit: vi.fn(),
      },
    };

    const module = await import("@/services/hotRefresh");
    const diagnostics: string[] = [];
    const onDiagnostic = (event: Event) => {
      diagnostics.push((event as CustomEvent<{ message: string }>).detail?.message ?? "");
    };
    window.addEventListener(
      module.OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT,
      onDiagnostic as EventListener
    );

    const teardown = await module.initHotRefresh();

    expect(tauriEventMocks.listen).not.toHaveBeenCalled();
    expect(apiMocks.hotRefreshStart).not.toHaveBeenCalled();
    expect(
      diagnostics.some((message) =>
        message.includes("Hot refresh could not attach Tauri event listeners.")
      )
    ).toBe(false);

    window.removeEventListener(
      module.OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT,
      onDiagnostic as EventListener
    );
    teardown();
  });

  it("reloads when broadcast-channel message comes from another window", async () => {
    const module = await import("@/services/hotRefresh");
    const reloadSpy = vi.fn();
    module.__setHotRefreshReloadForTests(reloadSpy);

    const teardown = await module.initHotRefresh();

    const externalChannel = new MockBroadcastChannel("opcode-hot-refresh");
    externalChannel.postMessage({
      requestId: "external-1",
      sourceId: "remote-window",
      reason: "cross_window",
      payload: { source: "test" },
    });

    vi.advanceTimersByTime(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    externalChannel.close();
    teardown();
  });

  it("enforces loop guard and blocks reload storms", async () => {
    const module = await import("@/services/hotRefresh");
    const reloadSpy = vi.fn();
    module.__setHotRefreshReloadForTests(reloadSpy);

    const diagnostics: string[] = [];
    const onDiagnostic = (event: Event) => {
      diagnostics.push(
        (event as CustomEvent<{ message: string }>).detail?.message ?? ""
      );
    };

    window.addEventListener(
      module.OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT,
      onDiagnostic as EventListener
    );

    const teardown = await module.initHotRefresh();

    for (let index = 0; index < 5; index += 1) {
      module.requestHotRefresh("manual", { source: `test-${index}` });
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(2_100);
    }

    expect(reloadSpy).toHaveBeenCalledTimes(4);
    expect(diagnostics.some((message) => message.includes("paused temporarily"))).toBe(true);

    window.removeEventListener(
      module.OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT,
      onDiagnostic as EventListener
    );

    teardown();
  });
});
