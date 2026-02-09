import { api } from '@/lib/api';

export interface WorkspaceMirrorState {
  tabs: unknown[];
  activeTabId: string | null;
  utilityOverlay?: string | null;
  utilityPayload?: unknown;
}

export interface MobileSyncBridgeEvent {
  eventType: string;
  payload: unknown;
}

type UnlistenFn = () => void;

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).__TAURI__ || (window as any).__TAURI_METADATA__);
}

function toSerializable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, current) => {
      if (current instanceof Date) {
        return current.toISOString();
      }
      return current;
    })
  ) as T;
}

class MobileSyncBridge {
  private snapshotInFlight = false;
  private actionUnlisten: UnlistenFn | null = null;

  async initializeActionBridge(): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (this.actionUnlisten) return;

    try {
      const tauriEvent = await import('@tauri-apps/api/event');
      const unlisten = await tauriEvent.listen('mobile-action-requested', (event) => {
        window.dispatchEvent(
          new CustomEvent('mobile-action-requested', {
            detail: event.payload,
          })
        );
      });

      this.actionUnlisten = () => {
        unlisten();
      };
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to initialize action bridge:', error);
    }
  }

  teardownActionBridge(): void {
    if (!this.actionUnlisten) return;
    this.actionUnlisten();
    this.actionUnlisten = null;
  }

  async publishSnapshot(state: WorkspaceMirrorState): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (this.snapshotInFlight) return;

    this.snapshotInFlight = true;
    try {
      const snapshot = toSerializable({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        utilityOverlay: state.utilityOverlay ?? null,
        utilityPayload: state.utilityPayload ?? null,
      });
      await api.mobileSyncPublishSnapshot(snapshot as Record<string, any>);
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to publish snapshot:', error);
    } finally {
      this.snapshotInFlight = false;
    }
  }

  async publishEvents(events: MobileSyncBridgeEvent[]): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (events.length === 0) return;

    try {
      await api.mobileSyncPublishEvents(
        events.map((event) => ({
          eventType: event.eventType,
          payload: toSerializable(event.payload),
        }))
      );
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to publish events:', error);
    }
  }
}

export const mobileSyncBridge = new MobileSyncBridge();
