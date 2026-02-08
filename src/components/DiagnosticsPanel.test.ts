import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";

vi.mock("@/hooks/useTabState", () => ({
  useTabState: () => ({
    tabs: [],
    activeTabId: null,
    switchToTab: vi.fn(),
    setActiveTerminalTab: vi.fn(),
    activatePane: vi.fn(),
  }),
}));

describe("DiagnosticsPanel terminal debug controls", () => {
  it("renders terminal hang debug actions", () => {
    const html = renderToStaticMarkup(React.createElement(DiagnosticsPanel));

    expect(html).toContain("Capture Terminal Snapshot");
    expect(html).toContain("Report Terminal Hang");
    expect(html).toContain("Run Terminal Stress Test (30s)");
  });
});
