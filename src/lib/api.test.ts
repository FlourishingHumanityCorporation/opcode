import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apiAdapter", () => ({
  apiCall: vi.fn(),
}));

import { api } from "@/lib/api";
import { apiCall } from "@/lib/apiAdapter";

const apiCallMock = vi.mocked(apiCall);

describe("api.closeEmbeddedTerminal", () => {
  beforeEach(() => {
    apiCallMock.mockReset();
    apiCallMock.mockResolvedValue(undefined);
  });

  it("passes terminatePersistentSession when explicitly provided", async () => {
    await api.closeEmbeddedTerminal("term-1", { terminatePersistentSession: false });

    expect(apiCallMock).toHaveBeenCalledWith("close_embedded_terminal", {
      terminalId: "term-1",
      terminatePersistentSession: false,
    });
  });

  it("keeps backward-compatible payload when options are omitted", async () => {
    await api.closeEmbeddedTerminal("term-2");

    expect(apiCallMock).toHaveBeenCalledWith("close_embedded_terminal", {
      terminalId: "term-2",
      terminatePersistentSession: undefined,
    });
  });
});

describe("terminal incident APIs", () => {
  beforeEach(() => {
    apiCallMock.mockReset();
  });

  it("fetches embedded terminal debug snapshot", async () => {
    apiCallMock.mockResolvedValue({
      capturedAtMs: 1,
      sessionCount: 0,
      sessions: [],
    });

    const snapshot = await api.getEmbeddedTerminalDebugSnapshot();

    expect(apiCallMock).toHaveBeenCalledWith("get_embedded_terminal_debug_snapshot");
    expect(snapshot.sessionCount).toBe(0);
  });

  it("writes terminal incident bundle payload", async () => {
    apiCallMock.mockResolvedValue("/tmp/incident-1.json");
    const payload = { hello: "world" };

    const path = await api.writeTerminalIncidentBundle(payload, "test-note");

    expect(apiCallMock).toHaveBeenCalledWith("write_terminal_incident_bundle", {
      payload,
      note: "test-note",
    });
    expect(path).toBe("/tmp/incident-1.json");
  });
});
