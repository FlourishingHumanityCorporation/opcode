import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/EmbeddedTerminal", () => ({
  EmbeddedTerminal: () => null,
}));
import {
  shouldEmitNeedsInputAttention,
  shouldShowProjectPathHeader,
  shouldShowProviderSelectorInHeader,
} from "@/components/ProviderSessionPane";
import { normalizeProviderSessionCompletion } from "@/components/provider-session-pane/sessionEventBus";

describe("ProviderSessionPane header behavior", () => {
  it("shows header when the project bar is visible", () => {
    expect(shouldShowProjectPathHeader(false)).toBe(true);
  });

  it("hides provider selector in terminal-only mode", () => {
    expect(shouldShowProviderSelectorInHeader()).toBe(false);
  });

  it("hides header when the project bar is hidden", () => {
    expect(shouldShowProjectPathHeader(true)).toBe(false);
  });

  it("normalizes legacy boolean completion payloads", () => {
    expect(normalizeProviderSessionCompletion(true)).toEqual({
      status: "success",
      success: true,
    });
    expect(normalizeProviderSessionCompletion(false)).toEqual({
      status: "error",
      success: false,
    });
  });

  it("normalizes structured completion payloads", () => {
    expect(
      normalizeProviderSessionCompletion({
        status: "success",
        success: true,
        session_id: "runtime-session-1",
        provider_id: "claude",
      })
    ).toEqual({
      status: "success",
      success: true,
      sessionId: "runtime-session-1",
      providerId: "claude",
    });
  });

  it("normalizes cancelled completion payloads", () => {
    expect(
      normalizeProviderSessionCompletion({
        status: "cancelled",
        success: false,
        error: "Provider session cancelled",
      })
    ).toEqual({
      status: "cancelled",
      success: false,
      error: "Provider session cancelled",
    });
  });

  it("flags needs_input for request_user_input tool events", () => {
    expect(
      shouldEmitNeedsInputAttention({
        type: "system",
        subtype: "event",
        item: {
          type: "tool_use",
          name: "request_user_input",
          input: {
            questions: [
              {
                header: "Approval",
                question: "Should I continue?",
              },
            ],
          },
        },
      } as any)
    ).toBe(true);
  });
});
