import { logger } from '@/lib/logger';

let tauriListenPromise: Promise<any> | null = null;

export function debugLog(event: string, payload?: Record<string, unknown>): void {
  logger.debug('terminal', event, payload);
}

export async function getTauriListen(): Promise<any> {
  const hasTauriBridge =
    typeof window !== "undefined" &&
    (Boolean((window as any).__TAURI__) ||
      Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI_METADATA__));

  if (!hasTauriBridge) {
    return null;
  }

  if (!tauriListenPromise) {
    tauriListenPromise = import("@tauri-apps/api/event")
      .then((m) => m.listen)
      .catch((error) => {
        tauriListenPromise = null;
        logger.warn('terminal', 'failed to load Tauri listener', { error });
        return null;
      });
  }

  return tauriListenPromise;
}
