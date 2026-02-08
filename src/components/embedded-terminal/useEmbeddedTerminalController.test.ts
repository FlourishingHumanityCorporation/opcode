import { describe, expect, it } from "vitest";
import { shouldReattachUsingExistingTerminalId } from "@/components/embedded-terminal/useEmbeddedTerminalController";

describe("useEmbeddedTerminalController reattach policy", () => {
  it("reuses existing terminal id only when persistent session is absent", () => {
    expect(shouldReattachUsingExistingTerminalId("term-1", undefined)).toBe(true);
    expect(shouldReattachUsingExistingTerminalId("term-1", "opcode_workspace_terminal_pane")).toBe(
      false
    );
    expect(shouldReattachUsingExistingTerminalId(undefined, undefined)).toBe(false);
  });
});
