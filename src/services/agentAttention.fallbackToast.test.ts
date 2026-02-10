import { describe, expect, it } from "vitest";
import { mapAgentAttentionFallbackToToast } from "@/services/agentAttention";

describe("agentAttention fallback toast mapping", () => {
  it("maps needs_input to info toast", () => {
    expect(
      mapAgentAttentionFallbackToToast({
        kind: "needs_input",
        source: "provider_session",
        title: "Needs input",
        body: "Please choose an option.",
      })
    ).toEqual({
      message: "Please choose an option.",
      type: "info",
    });
  });

  it("maps done to success toast", () => {
    expect(
      mapAgentAttentionFallbackToToast({
        kind: "done",
        source: "agent_execution",
        title: "Done",
        body: "Run completed.",
      })
    ).toEqual({
      message: "Run completed.",
      type: "success",
    });
  });

  it("falls back to defaults when body is empty", () => {
    expect(
      mapAgentAttentionFallbackToToast({
        kind: "needs_input",
        source: "agent_execution",
        title: "Needs input",
        body: "   ",
      })
    ).toEqual({
      message: "The agent is waiting for your approval or decision.",
      type: "info",
    });
  });
});
