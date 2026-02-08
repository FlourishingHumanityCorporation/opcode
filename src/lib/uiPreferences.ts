import { api } from "@/lib/api";

export const PLAIN_TERMINAL_MODE_KEY = "plain_terminal_mode";
export const PLAIN_TERMINAL_MODE_EVENT = "opcode:plain-terminal-mode-changed";
export const NATIVE_TERMINAL_MODE_KEY = "native_terminal_mode";
export const NATIVE_TERMINAL_MODE_EVENT = "opcode:native-terminal-mode-changed";
export const NATIVE_TERMINAL_START_COMMAND_KEY = "native_terminal_start_command";
export const NATIVE_TERMINAL_START_COMMAND_EVENT = "opcode:native-terminal-start-command-changed";

function parseBool(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function readPlainTerminalModeFromStorage(): boolean {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return false;
  }

  const mirrored = window.localStorage.getItem(`app_setting:${PLAIN_TERMINAL_MODE_KEY}`);
  if (mirrored !== null) {
    return parseBool(mirrored);
  }

  const legacy = window.localStorage.getItem(PLAIN_TERMINAL_MODE_KEY);
  return parseBool(legacy);
}

export async function loadPlainTerminalModePreference(): Promise<boolean> {
  const cached = readPlainTerminalModeFromStorage();

  try {
    const stored = await api.getSetting(PLAIN_TERMINAL_MODE_KEY);
    if (stored === null) {
      return cached;
    }
    const enabled = parseBool(stored);
    if (typeof window !== "undefined" && "localStorage" in window) {
      window.localStorage.setItem(`app_setting:${PLAIN_TERMINAL_MODE_KEY}`, enabled ? "true" : "false");
      window.localStorage.setItem(PLAIN_TERMINAL_MODE_KEY, enabled ? "true" : "false");
    }
    return enabled;
  } catch (error) {
    console.warn("[uiPreferences] Failed to load plain terminal mode setting:", error);
    return cached;
  }
}

export async function savePlainTerminalModePreference(enabled: boolean): Promise<void> {
  if (typeof window !== "undefined" && "localStorage" in window) {
    window.localStorage.setItem(`app_setting:${PLAIN_TERMINAL_MODE_KEY}`, enabled ? "true" : "false");
    window.localStorage.setItem(PLAIN_TERMINAL_MODE_KEY, enabled ? "true" : "false");
    window.dispatchEvent(
      new CustomEvent(PLAIN_TERMINAL_MODE_EVENT, {
        detail: { enabled },
      })
    );
  }

  try {
    await api.saveSetting(PLAIN_TERMINAL_MODE_KEY, enabled ? "true" : "false");
  } catch (error) {
    console.warn("[uiPreferences] Failed to save plain terminal mode setting:", error);
  }
}

export function readNativeTerminalModeFromStorage(): boolean {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return false;
  }

  const mirrored = window.localStorage.getItem(`app_setting:${NATIVE_TERMINAL_MODE_KEY}`);
  if (mirrored !== null) {
    return parseBool(mirrored);
  }

  const legacy = window.localStorage.getItem(NATIVE_TERMINAL_MODE_KEY);
  return parseBool(legacy);
}

export async function loadNativeTerminalModePreference(): Promise<boolean> {
  const cached = readNativeTerminalModeFromStorage();

  try {
    const stored = await api.getSetting(NATIVE_TERMINAL_MODE_KEY);
    if (stored === null) {
      return cached;
    }
    const enabled = parseBool(stored);
    if (typeof window !== "undefined" && "localStorage" in window) {
      window.localStorage.setItem(`app_setting:${NATIVE_TERMINAL_MODE_KEY}`, enabled ? "true" : "false");
      window.localStorage.setItem(NATIVE_TERMINAL_MODE_KEY, enabled ? "true" : "false");
    }
    return enabled;
  } catch (error) {
    console.warn("[uiPreferences] Failed to load native terminal mode setting:", error);
    return cached;
  }
}

export async function saveNativeTerminalModePreference(enabled: boolean): Promise<void> {
  if (typeof window !== "undefined" && "localStorage" in window) {
    window.localStorage.setItem(`app_setting:${NATIVE_TERMINAL_MODE_KEY}`, enabled ? "true" : "false");
    window.localStorage.setItem(NATIVE_TERMINAL_MODE_KEY, enabled ? "true" : "false");
    window.dispatchEvent(
      new CustomEvent(NATIVE_TERMINAL_MODE_EVENT, {
        detail: { enabled },
      })
    );
  }

  try {
    await api.saveSetting(NATIVE_TERMINAL_MODE_KEY, enabled ? "true" : "false");
  } catch (error) {
    console.warn("[uiPreferences] Failed to save native terminal mode setting:", error);
  }
}

export function readNativeTerminalStartCommandFromStorage(): string {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return "";
  }

  const mirrored = window.localStorage.getItem(`app_setting:${NATIVE_TERMINAL_START_COMMAND_KEY}`);
  if (mirrored !== null) {
    return mirrored;
  }

  const legacy = window.localStorage.getItem(NATIVE_TERMINAL_START_COMMAND_KEY);
  return legacy ?? "";
}

export async function loadNativeTerminalStartCommandPreference(): Promise<string> {
  const cached = readNativeTerminalStartCommandFromStorage();

  try {
    const stored = await api.getSetting(NATIVE_TERMINAL_START_COMMAND_KEY);
    if (stored === null) {
      return cached;
    }
    if (typeof window !== "undefined" && "localStorage" in window) {
      window.localStorage.setItem(`app_setting:${NATIVE_TERMINAL_START_COMMAND_KEY}`, stored);
      window.localStorage.setItem(NATIVE_TERMINAL_START_COMMAND_KEY, stored);
    }
    return stored;
  } catch (error) {
    console.warn("[uiPreferences] Failed to load native terminal startup command setting:", error);
    return cached;
  }
}

export async function saveNativeTerminalStartCommandPreference(command: string): Promise<void> {
  const value = command ?? "";

  if (typeof window !== "undefined" && "localStorage" in window) {
    window.localStorage.setItem(`app_setting:${NATIVE_TERMINAL_START_COMMAND_KEY}`, value);
    window.localStorage.setItem(NATIVE_TERMINAL_START_COMMAND_KEY, value);
    window.dispatchEvent(
      new CustomEvent(NATIVE_TERMINAL_START_COMMAND_EVENT, {
        detail: { command: value },
      })
    );
  }

  try {
    await api.saveSetting(NATIVE_TERMINAL_START_COMMAND_KEY, value);
  } catch (error) {
    console.warn("[uiPreferences] Failed to save native terminal startup command setting:", error);
  }
}
