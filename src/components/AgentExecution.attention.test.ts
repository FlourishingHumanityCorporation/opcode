import { describe, expect, it } from "vitest";
import { shouldEmitNeedsInputAttention } from "@/components/agentAttentionDetection";

describe("AgentExecution needs-input detection", () => {
  it("returns true for request_user_input tool payloads", () => {
    expect(
      shouldEmitNeedsInputAttention({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "request_user_input",
              input: {
                questions: [
                  {
                    header: "Decision",
                    question: "Should I proceed?",
                  },
                ],
              },
            },
          ],
        },
      })
    ).toBe(true);
  });

  it("returns false for unrelated assistant messages", () => {
    expect(
      shouldEmitNeedsInputAttention({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Implemented successfully." }],
        },
      })
    ).toBe(false);
  });
});
