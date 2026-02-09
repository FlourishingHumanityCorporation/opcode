import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getClaudeSettings: vi.fn(),
  getClaudeBinaryPath: vi.fn(),
  listDetectedAgents: vi.fn(),
  mobileSyncGetStatus: vi.fn(),
  mobileSyncListDevices: vi.fn(),
  saveSetting: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@/hooks", () => ({
  useTheme: () => ({
    theme: "dark",
    themePreference: "dark",
    setTheme: vi.fn(),
    customColors: {},
    setCustomColors: vi.fn(),
  }),
  useTrackEvent: () => ({
    settingsChanged: vi.fn(),
  }),
}));

vi.mock("@/lib/analytics", () => ({
  analytics: {
    getSettings: vi.fn(() => ({ enabled: false })),
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
  },
}));

vi.mock("@/services/tabPersistence", () => ({
  TabPersistenceService: {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
  },
}));

vi.mock("@/components/ClaudeVersionSelector", () => ({
  ClaudeVersionSelector: () => React.createElement("div", { "data-testid": "mock-claude-version" }),
}));
vi.mock("@/components/StorageTab", () => ({
  StorageTab: () => React.createElement("div", { "data-testid": "mock-storage" }),
}));
vi.mock("@/components/HooksEditor", () => ({
  HooksEditor: () => React.createElement("div", { "data-testid": "mock-hooks" }),
}));
vi.mock("@/components/SlashCommandsManager", () => ({
  SlashCommandsManager: () => React.createElement("div", { "data-testid": "mock-commands" }),
}));
vi.mock("@/components/ProxySettings", () => ({
  ProxySettings: () => React.createElement("div", { "data-testid": "mock-proxy" }),
}));

import { Settings } from "@/components/Settings";

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderSettings(): Promise<{
  container: HTMLDivElement;
  root: Root;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(Settings, { onBack: vi.fn() }));
  });

  await flushEffects();
  await flushEffects();

  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function clickSwitchById(container: HTMLElement, id: string): void {
  const hiddenInput = container.querySelector(`#${id}`) as HTMLInputElement | null;
  if (!hiddenInput) {
    throw new Error(`Switch input not found: ${id}`);
  }
  const button = hiddenInput.closest("button");
  if (!button) {
    throw new Error(`Switch button not found: ${id}`);
  }
  button.click();
}

describe("Settings hot refresh controls", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();

    apiMocks.getClaudeSettings.mockResolvedValue({});
    apiMocks.getClaudeBinaryPath.mockResolvedValue(null);
    apiMocks.listDetectedAgents.mockResolvedValue([]);
    apiMocks.mobileSyncGetStatus.mockResolvedValue({
      enabled: false,
      port: 8091,
      publicHost: "",
      baseUrl: "",
      tailscaleIp: null,
    });
    apiMocks.mobileSyncListDevices.mockResolvedValue([]);

    apiMocks.getSetting.mockImplementation(async (key: string) => {
      if (key === "hot_refresh_enabled") return "true";
      if (key === "hot_refresh_scope") return "all";
      if (key === "hot_refresh_watch_paths") return JSON.stringify(["src", "src-tauri/src"]);
      return null;
    });
    apiMocks.saveSetting.mockResolvedValue(undefined);
  });

  it("persists the hot refresh enabled toggle", async () => {
    const { container, cleanup } = await renderSettings();

    try {
      await act(async () => {
        clickSwitchById(container, "hot-refresh-enabled");
      });

      expect(apiMocks.saveSetting).toHaveBeenCalledWith("hot_refresh_enabled", "false");
    } finally {
      await cleanup();
    }
  });

  it("persists scope and watch path updates", async () => {
    const { container, cleanup } = await renderSettings();

    try {
      const devOnlyButton = container.querySelector(
        '[data-testid="hot-refresh-scope-dev-only"]'
      ) as HTMLButtonElement | null;
      expect(devOnlyButton).toBeTruthy();

      await act(async () => {
        devOnlyButton?.click();
      });

      expect(apiMocks.saveSetting).toHaveBeenCalledWith("hot_refresh_scope", "dev_only");

      const allButton = container.querySelector(
        '[data-testid="hot-refresh-scope-all"]'
      ) as HTMLButtonElement | null;
      await act(async () => {
        allButton?.click();
      });
      await flushEffects();

      const pathsInput = container.querySelector(
        '[data-testid="hot-refresh-watch-paths"]'
      ) as HTMLTextAreaElement | null;
      expect(pathsInput).toBeTruthy();

      await act(async () => {
        if (pathsInput) {
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          );
          descriptor?.set?.call(pathsInput, "src\ncustom/path");
          pathsInput.dispatchEvent(new Event("input", { bubbles: true }));
          pathsInput.focus();
          pathsInput.blur();
        }
      });
      await flushEffects();

      expect(apiMocks.saveSetting).toHaveBeenCalledWith(
        "hot_refresh_watch_paths",
        JSON.stringify(["src", "custom/path"])
      );
    } finally {
      await cleanup();
    }
  });
});
