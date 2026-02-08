import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Project, type Session } from "@/lib/api";
import {
  buildSessionTranscript,
  deriveAutoTitleFromUserPrompts,
  extractUserPromptTexts,
  getAutoTitleTranscriptCursor,
  getNextAutoTitleCheckpointAtMs,
  isGenericTerminalTitle,
  listAutoTitleCheckpointMinutes,
  resolveLatestSessionSnapshot,
  sanitizeTerminalTitleCandidate,
  shouldGenerateAutoTitleForTranscript,
  shouldApplyAutoRenameTitle,
} from "@/services/terminalAutoTitle";

function makeProject(id: string, path: string): Project {
  return {
    id,
    path,
    sessions: [],
    created_at: 0,
  };
}

function makeSession(id: string, projectId = "project-1", projectPath = "/tmp/project"): Session {
  return {
    id,
    project_id: projectId,
    project_path: projectPath,
    created_at: Date.now(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("terminalAutoTitle snapshot selection", () => {
  it("prefers an explicitly provided session id over project-latest", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      makeProject("project-1", "/tmp/project"),
    ]);
    const getProjectSessionsSpy = vi.spyOn(api, "getProjectSessions").mockResolvedValue([
      makeSession("session-latest"),
    ]);
    const loadSessionHistorySpy = vi
      .spyOn(api, "loadProviderSessionHistory")
      .mockImplementation(async (sessionId: string) => {
        if (sessionId === "session-active") {
          return [{ type: "user", message: { content: "Fix batch embedding tests" } }];
        }
        if (sessionId === "session-latest") {
          return [{ type: "user", message: { content: "Unrelated latest session" } }];
        }
        return [];
      });

    const snapshot = await resolveLatestSessionSnapshot("/tmp/project", {
      preferredSessionId: "session-active",
    });

    expect(snapshot?.sessionId).toBe("session-active");
    expect(loadSessionHistorySpy).toHaveBeenCalledWith("session-active", "project-1");
    expect(getProjectSessionsSpy).not.toHaveBeenCalled();
  });

  it("returns null when preferred session lookup fails to avoid cross-session drift", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      makeProject("project-1", "/tmp/project"),
    ]);
    const getProjectSessionsSpy = vi.spyOn(api, "getProjectSessions").mockResolvedValue([
      makeSession("session-latest"),
      makeSession("session-older"),
    ]);
    const loadSessionHistorySpy = vi
      .spyOn(api, "loadProviderSessionHistory")
      .mockImplementation(async (sessionId: string) => {
        if (sessionId === "session-active") {
          throw new Error("session not found");
        }
        if (sessionId === "session-latest") {
          return [{ type: "user", message: { content: "Fix speaker mapping persistence" } }];
        }
        return [];
      });

    const snapshot = await resolveLatestSessionSnapshot("/tmp/project", {
      preferredSessionId: "session-active",
    });

    expect(snapshot).toBeNull();
    expect(loadSessionHistorySpy).toHaveBeenCalledWith("session-active", "project-1");
    expect(getProjectSessionsSpy).not.toHaveBeenCalled();
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
        "Fix MeetingMind calendar selection flow",
        undefined,
        "/Users/paulrohde/CodeProjects/apps/MeetingMind"
      )
    ).toBe("Fix calendar selection flow");
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
    expect(shouldApplyAutoRenameTitle("Terminal 1", "General assistance", false)).toBe(false);
    expect(shouldApplyAutoRenameTitle("Terminal 1", "New Name", true)).toBe(false);
    expect(shouldApplyAutoRenameTitle("Terminal 1", "New Name", false)).toBe(true);
  });

  it("flags generic titles and derives better fallback titles from prompts", () => {
    expect(isGenericTerminalTitle("General assistance")).toBe(true);
    expect(isGenericTerminalTitle("Chat with Assistant")).toBe(true);
    expect(isGenericTerminalTitle("Check VP CLI flags")).toBe(false);

    const fallback = deriveAutoTitleFromUserPrompts(
      ["Can you check VP transcribe CLI help for available flags in MeetingMind?"],
      "/Users/paulrohde/CodeProjects/apps/MeetingMind"
    );
    expect(fallback).toContain("VP");
    expect(fallback.toLowerCase()).not.toContain("meetingmind");
    expect(fallback.length).toBeGreaterThan(0);
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
