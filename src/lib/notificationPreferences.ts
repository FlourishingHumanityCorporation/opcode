import { api } from "@/lib/api";
import { logger } from "@/lib/logger";

export interface NotificationPreferences {
  enabled_done: boolean;
  enabled_needs_input: boolean;
  sound_enabled: boolean;
  sound_kind: "needs_input_only" | "all";
}

const DEFAULTS: NotificationPreferences = {
  enabled_done: true,
  enabled_needs_input: true,
  sound_enabled: false,
  sound_kind: "needs_input_only",
};

const STORAGE_KEY = "notification_preferences";
const LS_PREFIX = "app_setting:";
export const NOTIFICATION_PREFERENCES_CHANGED_EVENT =
  "codeinterfacex:notification-preferences-changed";

function lsKey(): string {
  return `${LS_PREFIX}${STORAGE_KEY}`;
}

export function readNotificationPreferencesFromStorage(): NotificationPreferences {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return { ...DEFAULTS };
  }

  const raw = window.localStorage.getItem(lsKey());
  if (!raw) return { ...DEFAULTS };

  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return {
      enabled_done:
        typeof parsed.enabled_done === "boolean"
          ? parsed.enabled_done
          : DEFAULTS.enabled_done,
      enabled_needs_input:
        typeof parsed.enabled_needs_input === "boolean"
          ? parsed.enabled_needs_input
          : DEFAULTS.enabled_needs_input,
      sound_enabled:
        typeof parsed.sound_enabled === "boolean"
          ? parsed.sound_enabled
          : DEFAULTS.sound_enabled,
      sound_kind:
        parsed.sound_kind === "needs_input_only" || parsed.sound_kind === "all"
          ? parsed.sound_kind
          : DEFAULTS.sound_kind,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeToLocalStorage(prefs: NotificationPreferences): void {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  window.localStorage.setItem(lsKey(), JSON.stringify(prefs));
  window.dispatchEvent(
    new CustomEvent(NOTIFICATION_PREFERENCES_CHANGED_EVENT, {
      detail: prefs,
    })
  );
}

export async function loadNotificationPreferences(): Promise<NotificationPreferences> {
  const cached = readNotificationPreferencesFromStorage();

  try {
    const stored = await api.getSetting(STORAGE_KEY);
    if (stored === null) return cached;

    const parsed =
      typeof stored === "string" ? JSON.parse(stored) : stored;
    const merged: NotificationPreferences = {
      enabled_done:
        typeof parsed.enabled_done === "boolean"
          ? parsed.enabled_done
          : cached.enabled_done,
      enabled_needs_input:
        typeof parsed.enabled_needs_input === "boolean"
          ? parsed.enabled_needs_input
          : cached.enabled_needs_input,
      sound_enabled:
        typeof parsed.sound_enabled === "boolean"
          ? parsed.sound_enabled
          : cached.sound_enabled,
      sound_kind:
        parsed.sound_kind === "needs_input_only" || parsed.sound_kind === "all"
          ? parsed.sound_kind
          : cached.sound_kind,
    };
    writeToLocalStorage(merged);
    return merged;
  } catch (error) {
    logger.warn(
      "misc",
      "[notificationPreferences] Failed to load from API:",
      { value: error }
    );
    return cached;
  }
}

export async function saveNotificationPreferences(
  prefs: NotificationPreferences
): Promise<void> {
  writeToLocalStorage(prefs);

  try {
    await api.saveSetting(STORAGE_KEY, JSON.stringify(prefs));
  } catch (error) {
    logger.warn(
      "misc",
      "[notificationPreferences] Failed to persist to API:",
      { value: error }
    );
  }
}
