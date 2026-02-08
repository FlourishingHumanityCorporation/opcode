import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/EmbeddedTerminal", () => ({
  EmbeddedTerminal: () => null,
}));
import {
  shouldShowProjectPathHeader,
  shouldShowProviderSelectorInHeader,
} from "@/components/ProviderSessionPane";
import { normalizeProviderSessionCompletion } from "@/components/provider-session-pane/sessionEventBus";

describe("ProviderSessionPane header behavior", () => {
  it("shows header in native mode even without detected providers", () => {
    expect(shouldShowProjectPathHeader(false, true, 0, "")).toBe(true);
  });

  it("hides provider selector in native mode", () => {
    expect(shouldShowProviderSelectorInHeader(true, 3)).toBe(false);
  });

  it("shows provider selector in non-native mode when providers are detected", () => {
    expect(shouldShowProviderSelectorInHeader(false, 2)).toBe(true);
  });

  it("shows header in non-native mode when project path exists", () => {
    expect(shouldShowProjectPathHeader(false, false, 0, "/Users/paulrohde/CodeProjects/apps/ProjectPulse")).toBe(
      true
    );
  });

  it("hides header only when hidden explicitly and no fallback conditions apply", () => {
    expect(shouldShowProjectPathHeader(true, false, 0, "")).toBe(false);
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
});
