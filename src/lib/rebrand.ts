const LEGACY_PREFIX = "opcode";
const ARCHIVE_PREFIX = "codeinterfacex.archive.localStorage.";
const REBRAND_MARKER = "codeinterfacex.rebrand.v1.complete";

export function archiveLegacyOpcodeLocalStorageState(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const storage = window.localStorage;
    if (storage.getItem(REBRAND_MARKER)) {
      return;
    }

    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(LEGACY_PREFIX)) {
        legacyKeys.push(key);
      }
    }

    if (legacyKeys.length > 0) {
      const entries = Object.fromEntries(
        legacyKeys.map((key) => [key, storage.getItem(key)])
      );
      const payload = {
        archivedAt: new Date().toISOString(),
        sourcePrefix: LEGACY_PREFIX,
        entries,
      };
      const archiveKey = `${ARCHIVE_PREFIX}${Date.now()}`;
      storage.setItem(archiveKey, JSON.stringify(payload));

      for (const key of legacyKeys) {
        storage.removeItem(key);
      }
    }

    storage.setItem(REBRAND_MARKER, new Date().toISOString());
  } catch {
    // Keep startup resilient if storage is unavailable.
  }
}
