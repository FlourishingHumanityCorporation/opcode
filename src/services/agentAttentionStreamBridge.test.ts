import { describe, expect, it } from "vitest";
import {
  buildDoneAttentionPayload,
  buildNeedsInputAttentionPayload,
} from "@/services/agentAttentionStreamBridge";

describe("agentAttentionStreamBridge", () => {
  it("builds needs_input payload for request_user_input tool events", () => {
    const payload = buildNeedsInputAttentionPayload(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "request_user_input",
              input: {
                questions: [{ header: "Decision", question: "Should I proceed?" }],
              },
            },
          ],
        },
      },
      {
        source: "provider_session",
        workspaceId: "workspace-1",
        terminalTabId: "terminal-1",
      }
    );

    expect(payload).toEqual(
      expect.objectContaining({
        kind: "needs_input",
        source: "provider_session",
        workspaceId: "workspace-1",
        terminalTabId: "terminal-1",
      })
    );
  });

  it("returns null for non-attention message payloads", () => {
    const payload = buildNeedsInputAttentionPayload(
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Implemented changes and tests pass." }],
        },
      },
      {
        source: "agent_execution",
      }
    );

    expect(payload).toBeNull();
  });

  it("keeps source context for agent_execution needs_input payloads", () => {
    const payload = buildNeedsInputAttentionPayload(
      {
        type: "event",
        item: {
          type: "tool_use",
          recipient_name: "request_user_input",
        },
      },
      {
        source: "agent_execution",
      }
    );

    expect(payload?.source).toBe("agent_execution");
    expect(payload?.kind).toBe("needs_input");
  });

  it("builds done payload with explicit body", () => {
    const payload = buildDoneAttentionPayload(
      {
        source: "agent_run_output",
        workspaceId: "workspace-7",
        terminalTabId: "terminal-9",
      },
      "Agent completed successfully."
    );

    expect(payload).toEqual({
      kind: "done",
      source: "agent_run_output",
      workspaceId: "workspace-7",
      terminalTabId: "terminal-9",
      body: "Agent completed successfully.",
    });
  });

  it("uses default done body when body is empty", () => {
    const payload = buildDoneAttentionPayload(
      {
        source: "agent_execution",
      },
      "   "
    );

    expect(payload.body).toBe("A run completed successfully.");
  });
});
