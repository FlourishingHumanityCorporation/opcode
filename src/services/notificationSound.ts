import type { AgentAttentionKind } from "@/services/agentAttention";
import { readNotificationPreferencesFromStorage } from "@/lib/notificationPreferences";
import { logger } from "@/lib/logger";

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    return null;
  }
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  durationMs: number,
  gainValue = 0.15
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(gainValue, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + durationMs / 1000);
}

export async function playNotificationSound(
  kind: AgentAttentionKind
): Promise<void> {
  if (kind === "running") return;

  const prefs = readNotificationPreferencesFromStorage();
  if (!prefs.sound_enabled) return;
  if (prefs.sound_kind === "needs_input_only" && kind !== "needs_input") return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const now = ctx.currentTime;

    if (kind === "needs_input") {
      // Two-tone alert: 440Hz → 880Hz
      playTone(ctx, 440, now, 200, 0.12);
      playTone(ctx, 880, now + 0.22, 200, 0.12);
    } else {
      // Single soft chime for done
      playTone(ctx, 660, now, 150, 0.08);
    }
  } catch (error) {
    logger.warn("misc", "[notificationSound] Failed to play sound:", {
      value: error,
    });
  }
}
