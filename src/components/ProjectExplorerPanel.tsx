import React from "react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCcw,
  Shrink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type FileEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  getExpandedPaths as getPersistedExpandedPaths,
  setExpandedPaths as setPersistedExpandedPaths,
} from "@/lib/projectExplorerPreferences";

interface ProjectExplorerPanelProps {
  projectPath: string;
  workspaceId: string;
  isVisible?: boolean;
}

const DIRECTORY_CACHE_MAX_ENTRIES = 200;
const directoryCache = new Map<string, FileEntry[]>();
const directoryCacheOrder: string[] = [];

export function clearProjectExplorerDirectoryCache(): void {
  directoryCache.clear();
  directoryCacheOrder.splice(0, directoryCacheOrder.length);
}

function basename(path: string): string {
  if (!path) return "Project";
  const normalized = path.replace(/\\+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function isCodeFile(entry: FileEntry): boolean {
  const ext = (entry.extension || entry.name.split(".").pop() || "").toLowerCase();
  return [
    "c",
    "cc",
    "cpp",
    "go",
    "h",
    "hpp",
    "java",
    "js",
    "jsx",
    "py",
    "rb",
    "rs",
    "sh",
    "ts",
    "tsx",
  ].includes(ext);
}

function isTextFile(entry: FileEntry): boolean {
  const ext = (entry.extension || entry.name.split(".").pop() || "").toLowerCase();
  return ["json", "md", "toml", "txt", "xml", "yaml", "yml"].includes(ext);
}

function isHiddenEntry(entry: FileEntry): boolean {
  return entry.name.startsWith(".");
}

export function sortDirectoryEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_directory !== b.is_directory) {
      return a.is_directory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function filterDirectoryEntries(entries: FileEntry[], showHidden: boolean): FileEntry[] {
  return showHidden ? entries : entries.filter((entry) => !isHiddenEntry(entry));
}

export function toggleExpandedPath(expandedPaths: Set<string>, path: string): Set<string> {
  const next = new Set(expandedPaths);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

function getCachedDirectory(path: string): FileEntry[] | null {
  if (!directoryCache.has(path)) {
    return null;
  }
  return directoryCache.get(path) || null;
}

function setCachedDirectory(path: string, entries: FileEntry[]): void {
  if (!directoryCache.has(path)) {
    directoryCacheOrder.push(path);
  }

  directoryCache.set(path, entries);

  while (directoryCacheOrder.length > DIRECTORY_CACHE_MAX_ENTRIES) {
    const evictedPath = directoryCacheOrder.shift();
    if (!evictedPath) continue;
    directoryCache.delete(evictedPath);
  }
}

function clearDirectoryCacheForPrefix(pathPrefix: string): void {
  if (!pathPrefix) return;
  const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  const targets = directoryCacheOrder.filter(
    (entryPath) => entryPath === pathPrefix || entryPath.startsWith(prefix)
  );

  targets.forEach((entryPath) => {
    directoryCache.delete(entryPath);
    const index = directoryCacheOrder.indexOf(entryPath);
    if (index >= 0) {
      directoryCacheOrder.splice(index, 1);
    }
  });
}

function stripPathsByPrefix<T>(record: Record<string, T>, pathPrefix: string): Record<string, T> {
  const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  return Object.entries(record).reduce<Record<string, T>>((acc, [path, value]) => {
    if (path !== pathPrefix && !path.startsWith(prefix)) {
      acc[path] = value;
    }
    return acc;
  }, {});
}

export const ProjectExplorerPanel: React.FC<ProjectExplorerPanelProps> = ({
  projectPath,
  workspaceId,
  isVisible = true,
}) => {
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set());
  const [entriesByPath, setEntriesByPath] = React.useState<Record<string, FileEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = React.useState<Set<string>>(new Set());
  const [errorByPath, setErrorByPath] = React.useState<Record<string, string>>({});
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(true);

  const loadDirectory = React.useCallback(
    async (path: string, options?: { force?: boolean }) => {
      if (!path) return;
      const force = Boolean(options?.force);

      if (!force) {
        const cached = getCachedDirectory(path);
        if (cached) {
          setEntriesByPath((prev) => ({ ...prev, [path]: cached }));
          setErrorByPath((prev) => {
            if (!prev[path]) return prev;
            const next = { ...prev };
            delete next[path];
            return next;
          });
          return;
        }
      }

      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });

      try {
        const loadedEntries = sortDirectoryEntries(await api.listDirectoryContents(path));
        setCachedDirectory(path, loadedEntries);
        setEntriesByPath((prev) => ({ ...prev, [path]: loadedEntries }));
        setErrorByPath((prev) => {
          if (!prev[path]) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load directory.";
        setErrorByPath((prev) => ({ ...prev, [path]: message }));
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    []
  );

  React.useEffect(() => {
    if (!projectPath) {
      setExpandedPaths(new Set());
      setEntriesByPath({});
      setErrorByPath({});
      setSelectedPath(null);
      return;
    }

    const persisted = getPersistedExpandedPaths(projectPath);
    const seeded = new Set([projectPath, ...persisted]);
    setExpandedPaths(seeded);
    setSelectedPath(projectPath);
  }, [projectPath]);

  React.useEffect(() => {
    if (!projectPath) return;
    setPersistedExpandedPaths(projectPath, Array.from(expandedPaths));
  }, [expandedPaths, projectPath]);

  React.useEffect(() => {
    if (!projectPath || !isVisible) return;
    if (!entriesByPath[projectPath] && !loadingPaths.has(projectPath)) {
      void loadDirectory(projectPath);
    }
  }, [entriesByPath, isVisible, loadDirectory, loadingPaths, projectPath]);

  React.useEffect(() => {
    if (!projectPath || !isVisible) return;

    expandedPaths.forEach((path) => {
      if (!entriesByPath[path] && !loadingPaths.has(path) && !errorByPath[path]) {
        void loadDirectory(path);
      }
    });
  }, [entriesByPath, errorByPath, expandedPaths, isVisible, loadDirectory, projectPath, loadingPaths]);

  const handleToggleEntry = (entry: FileEntry) => {
    setSelectedPath(entry.path);
    if (!entry.is_directory) {
      return;
    }

    setExpandedPaths((prev) => {
      const next = toggleExpandedPath(prev, entry.path);
      if (!prev.has(entry.path) && !entriesByPath[entry.path] && !loadingPaths.has(entry.path)) {
        void loadDirectory(entry.path);
      }
      return next;
    });
  };

  const handleToggleRoot = () => {
    setSelectedPath(projectPath);
    if (!projectPath) return;

    setExpandedPaths((prev) => {
      const next = toggleExpandedPath(prev, projectPath);
      if (!prev.has(projectPath) && !entriesByPath[projectPath] && !loadingPaths.has(projectPath)) {
        void loadDirectory(projectPath);
      }
      return next;
    });
  };

  const handleRefresh = () => {
    if (!projectPath) return;

    clearDirectoryCacheForPrefix(projectPath);
    setEntriesByPath((prev) => stripPathsByPrefix(prev, projectPath));
    setErrorByPath((prev) => stripPathsByPrefix(prev, projectPath));

    Array.from(expandedPaths)
      .filter((path) => path === projectPath || path.startsWith(`${projectPath}/`))
      .forEach((path) => {
        void loadDirectory(path, { force: true });
      });
  };

  const handleCollapseAll = () => {
    if (!projectPath) return;
    setExpandedPaths(new Set([projectPath]));
  };

  const renderDirectoryContents = (parentPath: string, depth: number): React.ReactNode => {
    const parentEntries = filterDirectoryEntries(entriesByPath[parentPath] || [], showHidden);

    return parentEntries.map((entry) => {
      const isExpanded = entry.is_directory && expandedPaths.has(entry.path);
      const isSelected = selectedPath === entry.path;
      const entryLoading = loadingPaths.has(entry.path);
      const entryError = errorByPath[entry.path];

      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => handleToggleEntry(entry)}
            className={cn(
              "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors",
              isSelected
                ? "bg-[var(--color-chrome-active)] text-[var(--color-chrome-text-active)]"
                : "text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]"
            )}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            data-entry-path={entry.path}
            data-testid="project-explorer-entry"
          >
            {entry.is_directory ? (
              <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")} />
            ) : (
              <span className="inline-block h-3.5 w-3.5 shrink-0" />
            )}

            {entry.is_directory ? (
              isExpanded ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-500" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-sky-500" />
              )
            ) : isCodeFile(entry) ? (
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            ) : isTextFile(entry) ? (
              <FileText className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            ) : (
              <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}

            <span className="truncate">{entry.name}</span>
          </button>

          {isExpanded && (
            <>
              {entryLoading && (
                <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading...</span>
                </div>
              )}

              {!entryLoading && entryError && (
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-rose-500" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
                  <span className="truncate">{entryError}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      void loadDirectory(entry.path, { force: true });
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}

              {!entryLoading && !entryError && renderDirectoryContents(entry.path, depth + 1)}
            </>
          )}
        </div>
      );
    });
  };

  if (!projectPath) {
    return (
      <div
        className="flex h-full min-h-0 flex-col border-r border-[var(--color-chrome-border)] bg-[var(--color-chrome-bg)]"
        data-testid={`project-explorer-panel-${workspaceId}`}
      >
        <div className="flex h-9 items-center border-b border-[var(--color-chrome-border)] px-2 text-xs text-muted-foreground">
          Select a project to browse files.
        </div>
      </div>
    );
  }

  const rootName = basename(projectPath);
  const isRootExpanded = expandedPaths.has(projectPath);
  const rootLoading = loadingPaths.has(projectPath);
  const rootError = errorByPath[projectPath];

  return (
    <div
      className="flex h-full min-h-0 flex-col border-r border-[var(--color-chrome-border)] bg-[var(--color-chrome-bg)]"
      data-testid={`project-explorer-panel-${workspaceId}`}
    >
      <div className="flex h-9 items-center justify-between border-b border-[var(--color-chrome-border)] px-1.5">
        <div className="truncate px-1 text-xs font-medium text-[var(--color-chrome-text-active)]">Explorer</div>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-[var(--color-chrome-text)]"
            title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
            aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
            onClick={() => setShowHidden((prev) => !prev)}
            data-testid="project-explorer-toggle-hidden"
          >
            {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-[var(--color-chrome-text)]"
            title="Collapse folders"
            aria-label="Collapse folders"
            onClick={handleCollapseAll}
            data-testid="project-explorer-collapse"
          >
            <Shrink className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-[var(--color-chrome-text)]"
            title="Refresh explorer"
            aria-label="Refresh explorer"
            onClick={handleRefresh}
            data-testid="project-explorer-refresh"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        <button
          type="button"
          onClick={handleToggleRoot}
          className={cn(
            "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors",
            selectedPath === projectPath
              ? "bg-[var(--color-chrome-active)] text-[var(--color-chrome-text-active)]"
              : "text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]"
          )}
          data-testid="project-explorer-root"
          data-entry-path={projectPath}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", isRootExpanded && "rotate-90")} />
          {isRootExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          )}
          <span className="truncate font-medium">{rootName}</span>
        </button>

        {isRootExpanded && (
          <>
            {rootLoading && (
              <div className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground" style={{ paddingLeft: "22px" }}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Loading...</span>
              </div>
            )}

            {!rootLoading && rootError && (
              <div className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-500">
                <div className="line-clamp-3">{rootError}</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    void loadDirectory(projectPath, { force: true });
                  }}
                >
                  Retry
                </Button>
              </div>
            )}

            {!rootLoading && !rootError && renderDirectoryContents(projectPath, 1)}
          </>
        )}
      </div>
    </div>
  );
};

export default ProjectExplorerPanel;
