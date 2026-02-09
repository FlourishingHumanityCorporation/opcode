import { describe, expect, it } from "vitest";
import {
  extractAttentionText,
  shouldTriggerNeedsInput,
  shouldTriggerNeedsInputFromMessage,
  summarizeAttentionBody,
} from "@/services/agentAttention";

describe("agentAttention needs-input matcher", () => {
  it("matches explicit approval and decision prompts", () => {
    const positives = [
      "I need your approval before I can run this command.",
      "Please confirm whether I should proceed with the migration.",
      "This action requires your input: choose one option to continue.",
      "Can I proceed with applying these changes?",
      "Permission required: approval requested to continue.",
    ];

    positives.forEach((text) => {
      expect(shouldTriggerNeedsInput(text)).toBe(true);
    });
  });

  it("ignores normal completion and informational responses", () => {
    const negatives = [
      "Implemented the feature and all unit tests pass.",
      "Here is the summary of what changed.",
      "The service starts successfully and handles retries.",
      "I finished the update and pushed no extra changes.",
      "Would you like a quick walkthrough of the files?",
    ];

    negatives.forEach((text) => {
      expect(shouldTriggerNeedsInput(text)).toBe(false);
    });
  });

  it("extracts assistant content text from stream message payloads", () => {
    const text = extractAttentionText({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Please confirm before I proceed." },
          { type: "text", text: { text: "Approval is required." } },
        ],
      },
    });

    expect(text).toContain("Please confirm before I proceed.");
    expect(text).toContain("Approval is required.");
    expect(shouldTriggerNeedsInput(text)).toBe(true);
  });

  it("summarizes long attention body text", () => {
    const input =
      "A".repeat(220) +
      " Please confirm if you want me to proceed with this destructive operation.";
    const summarized = summarizeAttentionBody(input);

    expect(summarized.length).toBeLessThanOrEqual(160);
  });

  it("detects needs_input from request_user_input tool payloads", () => {
    const message = {
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
                  question: "Should I apply the migration now?",
                },
              ],
            },
          },
        ],
      },
    };

    expect(shouldTriggerNeedsInputFromMessage(message)).toBe(true);
  });

  it("detects needs_input from non-assistant tool events", () => {
    const message = {
      type: "event",
      item: {
        type: "tool_use",
        recipient_name: "request_user_input",
        input: {
          questions: [
            {
              header: "Approval",
              question: "Choose whether to continue.",
            },
          ],
        },
      },
    };

    expect(shouldTriggerNeedsInputFromMessage(message)).toBe(true);
  });

  it("detects needs_input from nested multi-tool payloads", () => {
    const message = {
      type: "event",
      payload: {
        tool_uses: [
          {
            recipient_name: "read_file",
          },
          {
            recipient_name: "request_user_input",
            input: {
              questions: [
                {
                  question: "Pick one option to continue.",
                },
              ],
            },
          },
        ],
      },
    };

    expect(shouldTriggerNeedsInputFromMessage(message)).toBe(true);
  });

  it("handles cyclic payloads without recursion failures", () => {
    const cyclic: Record<string, unknown> = {
      type: "event",
    };
    cyclic.self = cyclic;
    cyclic.payload = {
      nested: cyclic,
    };

    expect(() => shouldTriggerNeedsInputFromMessage(cyclic)).not.toThrow();
    expect(shouldTriggerNeedsInputFromMessage(cyclic)).toBe(false);
  });

  it("does not trigger needs_input for unrelated tool usage", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "read_file",
            input: {
              path: "README.md",
            },
          },
        ],
      },
    };

    expect(shouldTriggerNeedsInputFromMessage(message)).toBe(false);
  });

  it("does not trigger for conversational preference prompts", () => {
    const text = "Would you like a walkthrough of the final diff?";
    expect(shouldTriggerNeedsInput(text)).toBe(false);
    expect(shouldTriggerNeedsInputFromMessage({ type: "assistant", text })).toBe(false);
  });
});
