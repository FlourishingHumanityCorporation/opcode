import {
  STALE_INPUT_THRESHOLD_MS,
  STALE_RECOVERY_COOLDOWN_MS,
} from "@/components/embedded-terminal/constants";
import type { StaleInputRecoveryCandidate } from "@/components/embedded-terminal/types";

export function shouldAttemptStaleInputRecovery({
  isInteractive,
  isRunning,
  lastInputAttemptAt,
  lastOutputAt,
  now,
  lastRecoveryAt,
  thresholdMs = STALE_INPUT_THRESHOLD_MS,
  cooldownMs = STALE_RECOVERY_COOLDOWN_MS,
}: StaleInputRecoveryCandidate): boolean {
  if (!isInteractive || !isRunning || !lastInputAttemptAt) {
    return false;
  }
  if (now - lastRecoveryAt < cooldownMs) {
    return false;
  }
  const outputAt = lastOutputAt ?? 0;
  if (lastInputAttemptAt <= outputAt) {
    return false;
  }
  return now - lastInputAttemptAt >= thresholdMs;
}
