import {
  extractAttentionText,
  shouldTriggerNeedsInputFromMessage,
  summarizeAttentionBody,
  type AgentAttentionSource,
  type EmitAgentAttentionInput,
} from "@/services/agentAttention";

export interface AgentAttentionStreamContext {
  source: AgentAttentionSource;
  workspaceId?: string;
  terminalTabId?: string;
}

const DEFAULT_NEEDS_INPUT_BODY = "The agent is waiting for your input.";
const DEFAULT_DONE_BODY = "A run completed successfully.";

function withContext(
  context: AgentAttentionStreamContext,
  payload: Pick<EmitAgentAttentionInput, "kind" | "body">
): EmitAgentAttentionInput {
  return {
    kind: payload.kind,
    body: payload.body,
    source: context.source,
    workspaceId: context.workspaceId,
    terminalTabId: context.terminalTabId,
  };
}

export function buildNeedsInputAttentionPayload(
  message: unknown,
  context: AgentAttentionStreamContext
): EmitAgentAttentionInput | null {
  if (!shouldTriggerNeedsInputFromMessage(message)) {
    return null;
  }

  const candidateText = extractAttentionText(message);
  return withContext(context, {
    kind: "needs_input",
    body: summarizeAttentionBody(candidateText) || DEFAULT_NEEDS_INPUT_BODY,
  });
}

export function buildDoneAttentionPayload(
  context: AgentAttentionStreamContext,
  body?: string
): EmitAgentAttentionInput {
  const normalizedBody = typeof body === "string" ? body.trim() : "";
  return withContext(context, {
    kind: "done",
    body: normalizedBody || DEFAULT_DONE_BODY,
  });
}
