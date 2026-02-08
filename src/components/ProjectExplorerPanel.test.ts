import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type FileEntry } from "@/lib/api";
import {
  ProjectExplorerPanel,
  clearProjectExplorerDirectoryCache,
} from "@/components/ProjectExplorerPanel";

vi.mock("@/lib/api", () => ({
  api: {
    listDirectoryContents: vi.fn(),
  },
}));

function entry(
  name: string,
  path: string,
  isDirectory: boolean,
  extension?: string
): FileEntry {
  return {
    name,
    path,
    is_directory: isDirectory,
    size: 0,
    extension,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel(projectPath = "/repo"): Promise<{
  container: HTMLDivElement;
  root: Root;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(ProjectExplorerPanel, {
        projectPath,
        workspaceId: "workspace-1",
        isVisible: true,
      })
    );
  });

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

function getEntryLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="project-explorer-entry"]')).map(
    (node) => (node.textContent || "").trim()
  );
}

function getEntryByPath(container: HTMLElement, path: string): HTMLElement | null {
  return container.querySelector(`[data-entry-path="${path}"]`) as HTMLElement | null;
}

describe("ProjectExplorerPanel", () => {
  const listDirectoryContentsMock = vi.mocked(api.listDirectoryContents);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    clearProjectExplorerDirectoryCache();
    localStorage.clear();
  });

  it("sorts root entries with directories first and renders them", async () => {
    listDirectoryContentsMock.mockResolvedValue([
      entry("z-file.ts", "/repo/z-file.ts", false, "ts"),
      entry("src", "/repo/src", true),
      entry("A-dir", "/repo/A-dir", true),
      entry("notes.md", "/repo/notes.md", false, "md"),
    ]);

    const { container, cleanup } = await renderPanel();
    try {
      await flushEffects();
      await flushEffects();

      const labels = getEntryLabels(container);
      expect(labels).toEqual(["A-dir", "src", "notes.md", "z-file.ts"]);
    } finally {
      await cleanup();
    }
  });

  it("lazy-loads folder contents when expanded and reuses cached children on re-open", async () => {
    listDirectoryContentsMock.mockImplementation(async (path: string) => {
      if (path === "/repo") {
        return [
          entry("src", "/repo/src", true),
          entry("README.md", "/repo/README.md", false, "md"),
        ];
      }
      if (path === "/repo/src") {
        return [entry("index.ts", "/repo/src/index.ts", false, "ts")];
      }
      return [];
    });

    const { container, cleanup } = await renderPanel();
    try {
      await flushEffects();
      await flushEffects();
      expect(listDirectoryContentsMock).toHaveBeenCalledWith("/repo");

      const srcEntry = getEntryByPath(container, "/repo/src");
      expect(srcEntry).toBeTruthy();

      await act(async () => {
        srcEntry?.click();
      });
      await flushEffects();
      await flushEffects();

      expect(listDirectoryContentsMock).toHaveBeenCalledWith("/repo/src");
      expect(container.textContent).toContain("index.ts");

      await act(async () => {
        srcEntry?.click();
      });
      await flushEffects();

      await act(async () => {
        srcEntry?.click();
      });
      await flushEffects();
      await flushEffects();

      const childLoads = listDirectoryContentsMock.mock.calls.filter(([path]) => path === "/repo/src");
      expect(childLoads).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("toggles hidden file visibility from the toolbar", async () => {
    listDirectoryContentsMock.mockResolvedValue([
      entry(".git", "/repo/.git", true),
      entry("src", "/repo/src", true),
      entry("README.md", "/repo/README.md", false, "md"),
    ]);

    const { container, cleanup } = await renderPanel();
    try {
      await flushEffects();
      await flushEffects();

      expect(container.textContent).toContain(".git");

      const hiddenToggle = container.querySelector(
        '[data-testid="project-explorer-toggle-hidden"]'
      ) as HTMLButtonElement | null;
      expect(hiddenToggle).toBeTruthy();

      await act(async () => {
        hiddenToggle?.click();
      });
      await flushEffects();

      expect(container.textContent).not.toContain(".git");

      await act(async () => {
        hiddenToggle?.click();
      });
      await flushEffects();

      expect(container.textContent).toContain(".git");
    } finally {
      await cleanup();
    }
  });

  it("shows an inline directory error and retries successfully", async () => {
    let failChildLoad = true;

    listDirectoryContentsMock.mockImplementation(async (path: string) => {
      if (path === "/repo") {
        return [entry("broken", "/repo/broken", true)];
      }
      if (path === "/repo/broken") {
        if (failChildLoad) {
          failChildLoad = false;
          throw new Error("Permission denied");
        }
        return [entry("ok.txt", "/repo/broken/ok.txt", false, "txt")];
      }
      return [];
    });

    const { container, cleanup } = await renderPanel();
    try {
      await flushEffects();
      await flushEffects();

      const brokenEntry = getEntryByPath(container, "/repo/broken");
      expect(brokenEntry).toBeTruthy();

      await act(async () => {
        brokenEntry?.click();
      });
      await flushEffects();
      await flushEffects();

      expect(container.textContent).toContain("Permission denied");

      const retryButton = Array.from(container.querySelectorAll("button")).find((button) =>
        (button.textContent || "").includes("Retry")
      ) as HTMLButtonElement | undefined;
      expect(retryButton).toBeTruthy();

      await act(async () => {
        retryButton?.click();
      });
      await flushEffects();
      await flushEffects();

      const retries = listDirectoryContentsMock.mock.calls.filter(([path]) => path === "/repo/broken");
      expect(retries).toHaveLength(2);
      expect(container.textContent).toContain("ok.txt");
    } finally {
      await cleanup();
    }
  });
});
