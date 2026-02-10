import { useCallback, useState } from "react";
import { logger } from '@/lib/logger';
import {
  resolveLatestSessionIdForProject,
  sanitizeProviderSessionId,
} from "@/services/nativeTerminalRestore";

export function useNativeTerminalRestore() {
  const [isResolvingNativeRestore, setIsResolvingNativeRestore] = useState(false);
  const [nativeRestoreNotice, setNativeRestoreNotice] = useState<string | null>(null);

  const resolveLatestProviderSession = useCallback(async (projectPath: string) => {
    setIsResolvingNativeRestore(true);
    setNativeRestoreNotice(null);

    try {
      const latestSessionId = await resolveLatestSessionIdForProject(projectPath);
      if (!latestSessionId) {
        setNativeRestoreNotice("No prior session found for this project. Starting fresh.");
        return undefined;
      }

      return sanitizeProviderSessionId(latestSessionId);
    } catch (error) {
      logger.warn('provider', '[ProviderSessionPane] Failed to resolve latest native restore session', { value: error });
      setNativeRestoreNotice("Could not load prior sessions. Starting fresh.");
      return undefined;
    } finally {
      setIsResolvingNativeRestore(false);
    }
  }, []);

  return {
    isResolvingNativeRestore,
    nativeRestoreNotice,
    setNativeRestoreNotice,
    resolveLatestProviderSession,
  };
}
