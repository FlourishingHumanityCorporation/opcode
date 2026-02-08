import { useCallback } from "react";
import { api } from "@/lib/api";
import { SessionPersistenceService } from "@/services/sessionPersistence";
import type { Session } from "@/lib/api";
import type { ProviderSessionMessage } from "@/lib/providerSessionProtocol";

export function useProviderSessionHistory() {
  const loadProviderSessionHistory = useCallback(async (session: Session) => {
    const history = await api.loadProviderSessionHistory(session.id, session.project_id);

    if (history && history.length > 0) {
      SessionPersistenceService.saveSession(
        session.id,
        session.project_id,
        session.project_path,
        history.length
      );
    }

    const loadedMessages: ProviderSessionMessage[] = history.map((entry: any) => ({
      ...entry,
      type: entry.type || "assistant",
    }));

    return {
      loadedMessages,
      rawJsonlOutput: history.map((entry: any) => JSON.stringify(entry)),
    };
  }, []);

  const isRunningProviderSession = useCallback((sessionId: string, processInfo: any) => {
    if (!processInfo?.process_type) return false;

    if ("ProviderSession" in processInfo.process_type) {
      return processInfo.process_type.ProviderSession.session_id === sessionId;
    }

    return false;
  }, []);

  return {
    loadProviderSessionHistory,
    isRunningProviderSession,
  };
}
