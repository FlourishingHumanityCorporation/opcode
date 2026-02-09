import { describe, expect, it } from "vitest";
import {
  buildKnownOutputPayloads,
  shouldProcessLiveOutputPayload,
} from "@/components/AgentRunOutputViewer";

describe("AgentRunOutputViewer live output dedupe", () => {
  it("seeds known payloads from loaded history/cache", () => {
    const known = buildKnownOutputPayloads([
      '{"type":"assistant","message":{"content":[]}}',
      "",
      "   ",
      '{"type":"result","result":"done"}',
    ]);

    expect(known.size).toBe(2);
  });

  it("processes first unseen live payload", () => {
    const known = buildKnownOutputPayloads([]);
    expect(
      shouldProcessLiveOutputPayload(
        known,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'
      )
    ).toBe(true);
  });

  it("skips duplicate live payload already present in history", () => {
    const payload = '{"type":"assistant","message":{"content":[{"type":"text","text":"same"}]}}';
    const known = buildKnownOutputPayloads([payload]);
    expect(shouldProcessLiveOutputPayload(known, payload)).toBe(false);
  });
});
