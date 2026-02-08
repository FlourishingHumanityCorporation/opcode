import { useCallback } from "react";
import {
  listenToProviderSessionEvent,
  PROVIDER_SESSION_EVENT_NAMES,
  providerSessionScopedEvent,
  type UnlistenFn,
} from "./sessionEventBus";

export function useProviderSessionStream() {
  const listenScoped = useCallback(
    async (
      sessionId: string,
      handlers: {
        onOutput?: (payload: any) => void;
        onError?: (payload: any) => void;
        onComplete?: (payload: any) => void;
        onCancelled?: (payload: any) => void;
      }
    ): Promise<UnlistenFn[]> => {
      const outputUnlisten = await listenToProviderSessionEvent(
        providerSessionScopedEvent(PROVIDER_SESSION_EVENT_NAMES.output, sessionId),
        (event) => handlers.onOutput?.(event.payload)
      );

      const errorUnlisten = await listenToProviderSessionEvent(
        providerSessionScopedEvent(PROVIDER_SESSION_EVENT_NAMES.error, sessionId),
        (event) => handlers.onError?.(event.payload)
      );

      const completeUnlisten = await listenToProviderSessionEvent(
        providerSessionScopedEvent(PROVIDER_SESSION_EVENT_NAMES.complete, sessionId),
        (event) => handlers.onComplete?.(event.payload)
      );

      const cancelledUnlisten = await listenToProviderSessionEvent(
        providerSessionScopedEvent(PROVIDER_SESSION_EVENT_NAMES.cancelled, sessionId),
        (event) => handlers.onCancelled?.(event.payload)
      );

      return [outputUnlisten, errorUnlisten, completeUnlisten, cancelledUnlisten];
    },
    []
  );

  const listenGeneric = useCallback(
    async (handlers: {
      onOutput?: (payload: any) => void;
      onError?: (payload: any) => void;
      onComplete?: (payload: any) => void;
      onCancelled?: (payload: any) => void;
    }): Promise<UnlistenFn[]> => {
      const outputUnlisten = await listenToProviderSessionEvent(
        PROVIDER_SESSION_EVENT_NAMES.output,
        (event) => handlers.onOutput?.(event.payload)
      );

      const errorUnlisten = await listenToProviderSessionEvent(
        PROVIDER_SESSION_EVENT_NAMES.error,
        (event) => handlers.onError?.(event.payload)
      );

      const completeUnlisten = await listenToProviderSessionEvent(
        PROVIDER_SESSION_EVENT_NAMES.complete,
        (event) => handlers.onComplete?.(event.payload)
      );

      const cancelledUnlisten = await listenToProviderSessionEvent(
        PROVIDER_SESSION_EVENT_NAMES.cancelled,
        (event) => handlers.onCancelled?.(event.payload)
      );

      return [outputUnlisten, errorUnlisten, completeUnlisten, cancelledUnlisten];
    },
    []
  );

  return {
    listenScoped,
    listenGeneric,
  };
}
