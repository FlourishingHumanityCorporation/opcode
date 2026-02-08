import { describe, expect, it } from "vitest";
import {
  extractAttentionText,
  shouldTriggerNeedsInput,
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
});

