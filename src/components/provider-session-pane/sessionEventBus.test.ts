import { describe, expect, it } from "vitest";
import { listenToProviderSessionEvent } from "@/components/provider-session-pane/sessionEventBus";

describe("sessionEventBus web-mode bridge detection", () => {
  it("uses DOM event listener when only __TAURI__ web shim is present", async () => {
    (window as any).__TAURI__ = {};
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI_METADATA__;

    const received: unknown[] = [];
    const unlisten = await listenToProviderSessionEvent("provider-session-output:test", (event) => {
      received.push(event.payload);
    });

    window.dispatchEvent(
      new CustomEvent("provider-session-output:test", {
        detail: { id: "event-1" },
      })
    );

    expect(received).toEqual([{ id: "event-1" }]);
    unlisten();
  });
});
