import { api } from "@/lib/api";

export const NATIVE_TERMINAL_START_COMMAND_KEY = "native_terminal_start_command";
export const NATIVE_TERMINAL_START_COMMAND_EVENT = "opcode:native-terminal-start-command-changed";

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
