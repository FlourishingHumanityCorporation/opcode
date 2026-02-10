import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DetectedProvider } from "./types";
import { logger } from '@/lib/logger';

interface UseProviderDetectionOptions {
  initialProviderId: string;
  isPaneVisible: boolean;
  onProviderChange?: (providerId: string) => void;
}

export function useProviderDetection({
  initialProviderId,
  isPaneVisible,
  onProviderChange,
}: UseProviderDetectionOptions) {
  const [activeProviderId, setActiveProviderId] = useState(initialProviderId || "claude");
  const [detectedProviders, setDetectedProviders] = useState<DetectedProvider[]>([]);

  useEffect(() => {
    setActiveProviderId(initialProviderId || "claude");
  }, [initialProviderId]);

  useEffect(() => {
    if (!isPaneVisible) return;
    let isCancelled = false;

    api
      .listDetectedAgents()
      .then((agents: any[]) => {
        if (isCancelled) return;

        const providers = agents.map((agent: any) => ({
          providerId: agent.provider_id,
          binaryPath: agent.binary_path,
          version: agent.version,
          source: agent.source,
        }));

        setDetectedProviders(providers);
        if (providers.length === 0) return;

        setActiveProviderId((current) => {
          const currentDetected = providers.some((p) => p.providerId === current);
          if (currentDetected) return current;

          const fallback =
            providers.find((p) => p.providerId === initialProviderId) ||
            providers.find((p) => p.providerId === "claude") ||
            providers[0];

          if (fallback && fallback.providerId !== current) {
            onProviderChange?.(fallback.providerId);
            return fallback.providerId;
          }

          return current;
        });
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        logger.warn('provider', '[ProviderSessionPane] Failed to detect agents:', { value: err });
      });

    return () => {
      isCancelled = true;
    };
  }, [initialProviderId, isPaneVisible, onProviderChange]);

  return {
    activeProviderId,
    setActiveProviderId,
    detectedProviders,
  };
}
