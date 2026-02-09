import { shouldTriggerNeedsInputFromMessage } from "@/services/agentAttention";

export function shouldEmitNeedsInputAttention(message: unknown): boolean {
  return shouldTriggerNeedsInputFromMessage(message);
}
