import { api } from "@/lib/api";

export const HOT_REFRESH_ENABLED_KEY = "hot_refresh_enabled";
export const HOT_REFRESH_SCOPE_KEY = "hot_refresh_scope";
export const HOT_REFRESH_WATCH_PATHS_KEY = "hot_refresh_watch_paths";
export const HOT_REFRESH_PREFERENCES_CHANGED_EVENT =
  "codeinterfacex:hot-refresh-preferences-changed";
export const HOT_REFRESH_RUNTIME_SCOPE_WARNING =
  "Hot refresh now tries to auto-converge existing windows/tabs after behavior changes. If a view still seems stale, open a new tab/window or restart.";
export const HOT_REFRESH_STALE_RUNTIME_ACTION =
  "If behavior seems stale, open a new tab/window.";

export type HotRefreshScope = "dev_only" | "all";

export interface HotRefreshPreferences {
  enabled: boolean;
  scope: HotRefreshScope;
  watchPaths: string[];
}

const DEFAULT_WATCH_PATHS = [
  "src",
  "src-tauri/src",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "package.json",
  "vite.config.ts",
];

function parseBoolean(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseScope(value: string | null | undefined): HotRefreshScope {
  return value === "dev_only" ? "dev_only" : "all";
}

function parseWatchPaths(value: string | null | undefined): string[] {
  if (!value) {
    return [...DEFAULT_WATCH_PATHS];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_WATCH_PATHS];
    }

    const normalized = parsed
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);

    return normalized.length > 0 ? normalized : [...DEFAULT_WATCH_PATHS];
  } catch {
    return [...DEFAULT_WATCH_PATHS];
  }
}

function dispatchPreferencesChanged(patch: Partial<HotRefreshPreferences>): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(HOT_REFRESH_PREFERENCES_CHANGED_EVENT, {
      detail: patch,
    })
  );
}

function mirrorSettingToLocalStorage(key: string, value: string): void {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return;
  }

  window.localStorage.setItem(`app_setting:${key}`, value);
}

export function defaultHotRefreshPreferences(): HotRefreshPreferences {
  return {
    enabled: true,
    scope: "all",
    watchPaths: [...DEFAULT_WATCH_PATHS],
  };
}

export function readHotRefreshEnabledFromStorage(): boolean {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return true;
  }

  const mirrored = window.localStorage.getItem(`app_setting:${HOT_REFRESH_ENABLED_KEY}`);
  return parseBoolean(mirrored, true);
}

export function readHotRefreshScopeFromStorage(): HotRefreshScope {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return "all";
  }

  const mirrored = window.localStorage.getItem(`app_setting:${HOT_REFRESH_SCOPE_KEY}`);
  return parseScope(mirrored);
}

export function readHotRefreshWatchPathsFromStorage(): string[] {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return [...DEFAULT_WATCH_PATHS];
  }

  const mirrored = window.localStorage.getItem(`app_setting:${HOT_REFRESH_WATCH_PATHS_KEY}`);
  return parseWatchPaths(mirrored);
}

export async function loadHotRefreshPreferences(): Promise<HotRefreshPreferences> {
  const fallback = {
    enabled: readHotRefreshEnabledFromStorage(),
    scope: readHotRefreshScopeFromStorage(),
    watchPaths: readHotRefreshWatchPathsFromStorage(),
  };

  try {
    const [enabledRaw, scopeRaw, watchPathsRaw] = await Promise.all([
      api.getSetting(HOT_REFRESH_ENABLED_KEY),
      api.getSetting(HOT_REFRESH_SCOPE_KEY),
      api.getSetting(HOT_REFRESH_WATCH_PATHS_KEY),
    ]);

    const enabled = parseBoolean(enabledRaw, fallback.enabled);
    const scope = parseScope(scopeRaw ?? fallback.scope);
    const watchPaths = parseWatchPaths(watchPathsRaw);

    mirrorSettingToLocalStorage(HOT_REFRESH_ENABLED_KEY, enabled ? "true" : "false");
    mirrorSettingToLocalStorage(HOT_REFRESH_SCOPE_KEY, scope);
    mirrorSettingToLocalStorage(HOT_REFRESH_WATCH_PATHS_KEY, JSON.stringify(watchPaths));

    return {
      enabled,
      scope,
      watchPaths,
    };
  } catch {
    return fallback;
  }
}

export async function saveHotRefreshEnabledPreference(enabled: boolean): Promise<void> {
  mirrorSettingToLocalStorage(HOT_REFRESH_ENABLED_KEY, enabled ? "true" : "false");
  await api.saveSetting(HOT_REFRESH_ENABLED_KEY, enabled ? "true" : "false");
  dispatchPreferencesChanged({ enabled });
}

export async function saveHotRefreshScopePreference(scope: HotRefreshScope): Promise<void> {
  mirrorSettingToLocalStorage(HOT_REFRESH_SCOPE_KEY, scope);
  await api.saveSetting(HOT_REFRESH_SCOPE_KEY, scope);
  dispatchPreferencesChanged({ scope });
}

export async function saveHotRefreshWatchPathsPreference(paths: string[]): Promise<void> {
  const normalized = paths.map((entry) => entry.trim()).filter(Boolean);
  const resolved = normalized.length > 0 ? normalized : [...DEFAULT_WATCH_PATHS];
  const serialized = JSON.stringify(resolved);

  mirrorSettingToLocalStorage(HOT_REFRESH_WATCH_PATHS_KEY, serialized);
  await api.saveSetting(HOT_REFRESH_WATCH_PATHS_KEY, serialized);
  dispatchPreferencesChanged({ watchPaths: resolved });
}

export function parseWatchPathsInput(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatWatchPathsInput(paths: string[]): string {
  return paths.join("\n");
}
