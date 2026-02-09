import { api } from "@/lib/api";
import {
  HOT_REFRESH_PREFERENCES_CHANGED_EVENT,
  type HotRefreshPreferences,
  loadHotRefreshPreferences,
} from "@/lib/hotRefreshPreferences";

export const OPCODE_HOT_REFRESH_REQUESTED_EVENT = "opcode-hot-refresh-requested";
export const OPCODE_HOT_REFRESH_BACKEND_EVENT = "opcode://hot-refresh-file-changed";
export const OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT =
  "opcode-hot-refresh-diagnostic";

const LOOP_GUARD_MIN_INTERVAL_MS = 2_000;
const LOOP_GUARD_WINDOW_MS = 30_000;
const LOOP_GUARD_MAX_RELOADS = 4;
const HMR_SETTLE_TIMEOUT_MS = 1_500;
const BROADCAST_CHANNEL_NAME = "opcode-hot-refresh";

export type HotRefreshReason =
  | "backend_file_change"
  | "cross_window"
  | "hmr_timeout"
  | "hmr_error"
  | "manual"
  | "settings_changed";

export interface HotRefreshPayload {
  source?: string;
  path?: string;
  paths?: string[];
}

interface HotRefreshWirePayload {
  requestId: string;
  sourceId: string;
  reason: HotRefreshReason;
  payload?: HotRefreshPayload;
}

export interface HotRefreshDiagnosticDetail {
  level: "info" | "error";
  message: string;
  reason?: HotRefreshReason;
}

interface HotRuntime {
  on: (event: string, callback: (payload: unknown) => void) => void;
  off?: (event: string, callback: (payload: unknown) => void) => void;
}

type UnlistenFn = () => void;

interface HotRefreshContext {
  sourceId: string;
  preferences: HotRefreshPreferences;
  reloadTimestamps: number[];
  hmrPending: boolean;
  hmrTimer: number | null;
  loopGuardTripped: boolean;
  desktopWatcherActive: boolean;
  broadcastChannel: BroadcastChannel | null;
  tauriUnlisteners: UnlistenFn[];
  domUnlisteners: UnlistenFn[];
  hmrUnsubscribers: Array<() => void>;
}

let activeContext: HotRefreshContext | null = null;
let reloadWindowImpl: () => void = () => {
  window.location.reload();
};

function emitDiagnostic(detail: HotRefreshDiagnosticDetail): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<HotRefreshDiagnosticDetail>(OPCODE_HOT_REFRESH_DIAGNOSTIC_EVENT, {
      detail,
    })
  );
}

function isTauriRuntimeAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(
    (window as any).__TAURI__ ||
      (window as any).__TAURI_INTERNALS__ ||
      (window as any).__TAURI_METADATA__
  );
}

function resolveHotRuntime(): HotRuntime | null {
  if (typeof globalThis === "undefined") {
    return null;
  }

  const testHot = (globalThis as any).__OPCODE_HOT_RUNTIME__ as HotRuntime | undefined;
  if (testHot?.on) {
    return testHot;
  }

  const viteHot = (import.meta as any).hot as HotRuntime | undefined;
  if (viteHot?.on) {
    return viteHot;
  }

  return null;
}

function nextRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clearHmrTimer(context: HotRefreshContext): void {
  if (context.hmrTimer === null) {
    return;
  }

  window.clearTimeout(context.hmrTimer);
  context.hmrTimer = null;
}

function scheduleHmrTimeout(context: HotRefreshContext): void {
  clearHmrTimer(context);

  context.hmrTimer = window.setTimeout(() => {
    if (!context.hmrPending) {
      return;
    }

    context.hmrPending = false;
    runHotRefresh(context, "hmr_timeout", { source: "hmr" }, true);
  }, HMR_SETTLE_TIMEOUT_MS);
}

function loopGuardAllowsReload(context: HotRefreshContext): boolean {
  const now = Date.now();
  context.reloadTimestamps = context.reloadTimestamps.filter(
    (timestamp) => now - timestamp <= LOOP_GUARD_WINDOW_MS
  );

  const lastReload = context.reloadTimestamps[context.reloadTimestamps.length - 1];
  if (typeof lastReload === "number" && now - lastReload < LOOP_GUARD_MIN_INTERVAL_MS) {
    return false;
  }

  if (context.reloadTimestamps.length >= LOOP_GUARD_MAX_RELOADS) {
    return false;
  }

  context.reloadTimestamps.push(now);
  return true;
}

function withContext(handler: (context: HotRefreshContext) => void): void {
  if (!activeContext) {
    return;
  }

  handler(activeContext);
}

async function syncDesktopWatcher(context: HotRefreshContext): Promise<void> {
  const tauriAvailable = isTauriRuntimeAvailable();
  if (!tauriAvailable) {
    return;
  }

  if (!context.preferences.enabled) {
    if (context.desktopWatcherActive) {
      try {
        await api.hotRefreshStop();
      } catch {
        // best-effort
      }
      context.desktopWatcherActive = false;
    }
    return;
  }

  if (context.preferences.scope !== "all") {
    if (context.desktopWatcherActive) {
      try {
        await api.hotRefreshStop();
      } catch {
        // best-effort
      }
      context.desktopWatcherActive = false;
    }
    return;
  }

  try {
    if (context.desktopWatcherActive) {
      await api.hotRefreshUpdatePaths(context.preferences.watchPaths);
    } else {
      await api.hotRefreshStart(context.preferences.watchPaths);
      context.desktopWatcherActive = true;
    }
  } catch (error) {
    context.desktopWatcherActive = false;
    emitDiagnostic({
      level: "error",
      message: `Failed to start desktop hot refresh watcher: ${ 
        error instanceof Error ? error.message : "Unknown error"
      }`,
      reason: "settings_changed",
    });
  }
}

async function setupTauriListeners(context: HotRefreshContext): Promise<void> {
  if (!isTauriRuntimeAvailable()) {
    return;
  }

  try {
    const tauriEvent = await import("@tauri-apps/api/event");

    const unlistenBackend = await tauriEvent.listen<HotRefreshPayload>(
      OPCODE_HOT_REFRESH_BACKEND_EVENT,
      (event) => {
        runHotRefresh(context, "backend_file_change", event.payload, true);
      }
    );

    const unlistenCrossWindow = await tauriEvent.listen<HotRefreshWirePayload>(
      OPCODE_HOT_REFRESH_REQUESTED_EVENT,
      (event) => {
        const detail = event.payload;
        if (!detail || detail.sourceId === context.sourceId) {
          return;
        }

        runHotRefresh(context, "cross_window", detail.payload, false);
      }
    );

    context.tauriUnlisteners.push(unlistenBackend, unlistenCrossWindow);
  } catch {
    emitDiagnostic({
      level: "error",
      message: "Hot refresh could not attach Tauri event listeners.",
      reason: "settings_changed",
    });
  }
}

async function emitCrossWindowRefresh(context: HotRefreshContext, detail: HotRefreshWirePayload) {
  if (context.broadcastChannel) {
    context.broadcastChannel.postMessage(detail);
  }

  if (!isTauriRuntimeAvailable()) {
    return;
  }

  try {
    const tauriEvent = await import("@tauri-apps/api/event");
    await tauriEvent.emit(OPCODE_HOT_REFRESH_REQUESTED_EVENT, detail);
  } catch {
    // best-effort propagation only
  }
}

function runHotRefresh(
  context: HotRefreshContext,
  reason: HotRefreshReason,
  payload?: HotRefreshPayload,
  propagate = true
): void {
  if (!context.preferences.enabled) {
    return;
  }

  if (context.loopGuardTripped) {
    return;
  }

  if (!loopGuardAllowsReload(context)) {
    context.loopGuardTripped = true;
    emitDiagnostic({
      level: "info",
      message:
        "Hot refresh paused temporarily to prevent reload loops. Disable/enable the setting to resume.",
      reason,
    });
    return;
  }

  const detail: HotRefreshWirePayload = {
    requestId: nextRequestId(),
    sourceId: context.sourceId,
    reason,
    payload,
  };

  if (propagate) {
    void emitCrossWindowRefresh(context, detail);
  }

  window.setTimeout(() => {
    reloadWindowImpl();
  }, 0);
}

function registerHmrHandlers(context: HotRefreshContext): void {
  const hotRuntime = resolveHotRuntime();
  if (!hotRuntime) {
    return;
  }

  const bindings: Array<[string, (payload: unknown) => void]> = [];

  const onBeforeUpdate = () => {
    context.hmrPending = true;
    scheduleHmrTimeout(context);
  };

  const onAfterUpdate = () => {
    context.hmrPending = false;
    clearHmrTimer(context);
  };

  const onError = () => {
    if (!context.hmrPending) {
      return;
    }

    context.hmrPending = false;
    clearHmrTimer(context);
    runHotRefresh(context, "hmr_error", { source: "hmr" }, true);
  };

  bindings.push(
    ["vite:beforeUpdate", onBeforeUpdate],
    ["vite:afterUpdate", onAfterUpdate],
    ["vite:beforePrune", onAfterUpdate],
    ["vite:beforeFullReload", onAfterUpdate],
    ["vite:error", onError]
  );

  bindings.forEach(([event, handler]) => {
    hotRuntime.on(event, handler);
    if (typeof hotRuntime.off === "function") {
      context.hmrUnsubscribers.push(() => {
        hotRuntime.off?.(event, handler);
      });
    }
  });
}

function registerDomListeners(context: HotRefreshContext): void {
  const onLocalRequest = (event: Event) => {
    const detail = (event as CustomEvent<HotRefreshWirePayload | undefined>).detail;
    if (!detail || (detail.sourceId && detail.sourceId === context.sourceId)) {
      return;
    }

    runHotRefresh(context, detail.reason ?? "manual", detail.payload, true);
  };

  window.addEventListener(OPCODE_HOT_REFRESH_REQUESTED_EVENT, onLocalRequest as EventListener);
  context.domUnlisteners.push(() => {
    window.removeEventListener(
      OPCODE_HOT_REFRESH_REQUESTED_EVENT,
      onLocalRequest as EventListener
    );
  });

  const onPreferencePatch = (event: Event) => {
    const patch = (event as CustomEvent<Partial<HotRefreshPreferences>>).detail;
    if (!patch) {
      return;
    }

    context.preferences = {
      ...context.preferences,
      ...patch,
      watchPaths: patch.watchPaths ?? context.preferences.watchPaths,
    };

    context.loopGuardTripped = false;
    void syncDesktopWatcher(context);
  };

  window.addEventListener(
    HOT_REFRESH_PREFERENCES_CHANGED_EVENT,
    onPreferencePatch as EventListener
  );
  context.domUnlisteners.push(() => {
    window.removeEventListener(
      HOT_REFRESH_PREFERENCES_CHANGED_EVENT,
      onPreferencePatch as EventListener
    );
  });
}

function registerBroadcastChannel(context: HotRefreshContext): void {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }

  const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  context.broadcastChannel = channel;

  channel.onmessage = (event: MessageEvent<HotRefreshWirePayload>) => {
    const detail = event.data;
    if (!detail || detail.sourceId === context.sourceId) {
      return;
    }

    runHotRefresh(context, "cross_window", detail.payload, false);
  };
}

export async function initHotRefresh(): Promise<() => void> {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  if (activeContext) {
    return () => undefined;
  }

  const preferences = await loadHotRefreshPreferences();
  const context: HotRefreshContext = {
    sourceId: `tab-${Math.random().toString(36).slice(2, 10)}`,
    preferences,
    reloadTimestamps: [],
    hmrPending: false,
    hmrTimer: null,
    loopGuardTripped: false,
    desktopWatcherActive: false,
    broadcastChannel: null,
    tauriUnlisteners: [],
    domUnlisteners: [],
    hmrUnsubscribers: [],
  };

  activeContext = context;

  registerDomListeners(context);
  registerBroadcastChannel(context);
  registerHmrHandlers(context);
  await setupTauriListeners(context);
  await syncDesktopWatcher(context);

  return () => {
    if (activeContext !== context) {
      return;
    }

    clearHmrTimer(context);
    context.hmrUnsubscribers.forEach((unsubscribe) => unsubscribe());
    context.domUnlisteners.forEach((unlisten) => unlisten());
    context.tauriUnlisteners.forEach((unlisten) => unlisten());

    if (context.broadcastChannel) {
      context.broadcastChannel.close();
      context.broadcastChannel = null;
    }

    if (isTauriRuntimeAvailable()) {
      void api.hotRefreshStop()
        .then(() => {
          context.desktopWatcherActive = false;
        })
        .catch(() => undefined);
    }
    activeContext = null;
  };
}

export function requestHotRefresh(
  reason: HotRefreshReason,
  payload?: HotRefreshPayload
): void {
  withContext((context) => {
    runHotRefresh(context, reason, payload, true);
  });
}

export function __setHotRefreshReloadForTests(reload: () => void): void {
  reloadWindowImpl = reload;
}

export function __resetHotRefreshForTests(): void {
  reloadWindowImpl = () => {
    window.location.reload();
  };

  if (activeContext) {
    activeContext.domUnlisteners.forEach((unlisten) => unlisten());
    activeContext.tauriUnlisteners.forEach((unlisten) => unlisten());
    activeContext.hmrUnsubscribers.forEach((unsubscribe) => unsubscribe());
    clearHmrTimer(activeContext);

    if (activeContext.broadcastChannel) {
      activeContext.broadcastChannel.close();
    }

    activeContext = null;
  }
}
