import { describe, expect, it } from "vitest";
import {
  buildSessionTranscript,
  extractUserPromptTexts,
  getAutoTitleTranscriptCursor,
  getNextAutoTitleCheckpointAtMs,
  listAutoTitleCheckpointMinutes,
  sanitizeTerminalTitleCandidate,
  shouldGenerateAutoTitleForTranscript,
  shouldApplyAutoRenameTitle,
} from "@/services/terminalAutoTitle";

describe("terminalAutoTitle cadence", () => {
  it("builds checkpoint sequence: 2, 10, 15, then every 5 minutes", () => {
    expect(listAutoTitleCheckpointMinutes(8)).toEqual([2, 10, 15, 20, 25, 30, 35, 40]);
  });

  it("computes next checkpoint based on elapsed time", () => {
    const start = 1_000;
    expect(getNextAutoTitleCheckpointAtMs(start, start)).toBe(start + 2 * 60_000);
    expect(getNextAutoTitleCheckpointAtMs(start, start + 9 * 60_000)).toBe(start + 10 * 60_000);
    expect(getNextAutoTitleCheckpointAtMs(start, start + 10 * 60_000)).toBe(start + 15 * 60_000);
    expect(getNextAutoTitleCheckpointAtMs(start, start + 15 * 60_000)).toBe(start + 20 * 60_000);
    expect(getNextAutoTitleCheckpointAtMs(start, start + 27 * 60_000)).toBe(start + 30 * 60_000);
  });
});

describe("terminalAutoTitle extraction and sanitization", () => {
  it("extracts user prompts from mixed history formats", () => {
    const history = [
      { type: "user", message: { content: [{ type: "text", text: " First prompt " }] } },
      { message: { role: "user", content: "Second prompt with   extra spaces" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Assistant output" }] } },
      { type: "user", message: { content: "<command-name>ignored</command-name>" } },
    ];

    expect(extractUserPromptTexts(history)).toEqual([
      "First prompt",
      "Second prompt with extra spaces",
    ]);
  });

  it("builds transcript with role labels and trims size", () => {
    const history = [
      { type: "user", message: { content: "Build a parser" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Sure, here's a plan" }] } },
    ];

    const transcript = buildSessionTranscript(history, 1000);
    expect(transcript).toContain("USER: Build a parser");
    expect(transcript).toContain("ASSISTANT: Sure, here's a plan");
  });

  it("sanitizes generated title and enforces single line", () => {
    expect(sanitizeTerminalTitleCandidate('  "Refactor Parser Pipeline"  \nextra')).toBe(
      "Refactor Parser Pipeline"
    );
    expect(sanitizeTerminalTitleCandidate("")).toBe("");
    expect(
      sanitizeTerminalTitleCandidate(
        "MeetingMind: Calendar Selection Fix",
        undefined,
        "/Users/paulrohde/CodeProjects/apps/MeetingMind"
      )
    ).toBe("Calendar Selection Fix");
    expect(
      sanitizeTerminalTitleCandidate(
        "MeetingMind",
        undefined,
        "/Users/paulrohde/CodeProjects/apps/MeetingMind"
      )
    ).toBe("");
  });

  it("skips rename when locked or unchanged", () => {
    expect(shouldApplyAutoRenameTitle("Refactor Parser Pipeline", "Refactor Parser Pipeline", false)).toBe(
      false
    );
    expect(shouldApplyAutoRenameTitle("Terminal 1", "New Name", true)).toBe(false);
    expect(shouldApplyAutoRenameTitle("Terminal 1", "New Name", false)).toBe(true);
  });

  it("only generates new title when transcript has progressed", () => {
    expect(shouldGenerateAutoTitleForTranscript("", undefined)).toBe(false);
    expect(shouldGenerateAutoTitleForTranscript("User asked to fix parser", undefined)).toBe(true);
    expect(
      shouldGenerateAutoTitleForTranscript(
        "User asked to fix parser",
        "User asked to fix parser"
      )
    ).toBe(false);
    expect(
      shouldGenerateAutoTitleForTranscript(
        "User asked to fix parser",
        "  User asked   to   fix parser  "
      )
    ).toBe(false);
    expect(
      shouldGenerateAutoTitleForTranscript(
        "User asked to fix parser and add tests",
        "User asked to fix parser"
      )
    ).toBe(true);
  });

  it("keeps transcript cursor stable for no-op updates", () => {
    expect(getAutoTitleTranscriptCursor("", "USER: prompt")).toBe("USER: prompt");
    expect(
      getAutoTitleTranscriptCursor("  USER: prompt  ", "USER: prompt")
    ).toBe("USER: prompt");
    expect(
      getAutoTitleTranscriptCursor("USER: prompt\nASSISTANT: reply", "USER: prompt")
    ).toBe("USER: prompt ASSISTANT: reply");
  });
});
