import { describe, expect, it } from "vitest";

import {
  normalizeProviderSessionCompletionPayload,
  normalizeProviderSessionMessage,
} from "./providerSessionProtocol";

describe("providerSessionProtocol", () => {
  it("normalizes legacy boolean completion payloads", () => {
    expect(normalizeProviderSessionCompletionPayload(true)).toEqual({
      status: "success",
      success: true,
    });
    expect(normalizeProviderSessionCompletionPayload(false)).toEqual({
      status: "error",
      success: false,
    });
  });

  it("normalizes structured completion payloads", () => {
    expect(
      normalizeProviderSessionCompletionPayload({
        status: "cancelled",
        success: false,
        session_id: "runtime-123",
        provider_id: "codex",
      })
    ).toEqual({
      status: "cancelled",
      success: false,
      sessionId: "runtime-123",
      providerId: "codex",
    });
  });

  it("parses provider session messages from json strings", () => {
    expect(
      normalizeProviderSessionMessage('{"type":"assistant","message":{"content":[]}}')
    ).toEqual({
      type: "assistant",
      message: { content: [] },
    });
  });

  it("returns null for invalid provider session payloads", () => {
    expect(normalizeProviderSessionMessage("not-json")).toBeNull();
    expect(normalizeProviderSessionMessage(null)).toBeNull();
    expect(normalizeProviderSessionMessage(undefined)).toBeNull();
  });
});
