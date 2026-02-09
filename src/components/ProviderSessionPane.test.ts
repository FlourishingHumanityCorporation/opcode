import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/EmbeddedTerminal", () => ({
  EmbeddedTerminal: () => null,
}));
import {
  resolveCanClosePane,
  resolveStreamingState,
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

  it("keeps pane close control disabled for single-pane mode", () => {
    expect(resolveCanClosePane(false)).toBe(false);
    expect(resolveCanClosePane(undefined)).toBe(true);
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

  it("uses native terminal stream activity for streaming state when native mode is enabled", () => {
    expect(
      resolveStreamingState({
        nativeTerminalMode: true,
        isLoading: false,
        nativeTerminalCommandActive: true,
      })
    ).toBe(true);
    expect(
      resolveStreamingState({
        nativeTerminalMode: true,
        isLoading: false,
        nativeTerminalStreaming: true,
      })
    ).toBe(true);
    expect(
      resolveStreamingState({
        nativeTerminalMode: true,
        isLoading: true,
        nativeTerminalStreaming: false,
      })
    ).toBe(false);
  });

  it("falls back to provider loading state when native mode is disabled", () => {
    expect(
      resolveStreamingState({
        nativeTerminalMode: false,
        isLoading: true,
        nativeTerminalStreaming: false,
      })
    ).toBe(true);
  });
});
