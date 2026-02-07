import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { api, type UsageStats, type ProjectUsage, type UsageIndexStatus } from "@/lib/api";
import { logWorkspaceEvent } from "@/services/workspaceDiagnostics";
import { 
  Calendar, 
  Filter,
  Info,
  Loader2,
  Briefcase,
  ChevronLeft,
  ChevronRight
} from "lucide-react";

interface UsageDashboardProps {
  /**
   * Callback when back button is clicked
   */
  onBack: () => void;
}

// Cache for storing fetched data
const dataCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes cache - increased for better performance

const EMPTY_USAGE_STATS: UsageStats = {
  total_cost: 0,
  total_tokens: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_creation_tokens: 0,
  total_cache_read_tokens: 0,
  total_sessions: 0,
  by_model: [],
  by_date: [],
  by_project: [],
};

function toFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = Math.floor(toFiniteNumber(value));
  return parsed >= 0 ? parsed : 0;
}

function sanitizeUsageStats(raw: unknown): UsageStats {
  if (!raw || typeof raw !== "object") {
    return EMPTY_USAGE_STATS;
  }

  const input = raw as any;
  return {
    total_cost: toFiniteNumber(input.total_cost),
    total_tokens: toNonNegativeInteger(input.total_tokens),
    total_input_tokens: toNonNegativeInteger(input.total_input_tokens),
    total_output_tokens: toNonNegativeInteger(input.total_output_tokens),
    total_cache_creation_tokens: toNonNegativeInteger(input.total_cache_creation_tokens),
    total_cache_read_tokens: toNonNegativeInteger(input.total_cache_read_tokens),
    total_sessions: toNonNegativeInteger(input.total_sessions),
    by_model: Array.isArray(input.by_model)
      ? input.by_model.map((model: any) => ({
          model: typeof model?.model === "string" ? model.model : "unknown",
          total_cost: toFiniteNumber(model?.total_cost),
          total_tokens: toNonNegativeInteger(model?.total_tokens),
          input_tokens: toNonNegativeInteger(model?.input_tokens),
          output_tokens: toNonNegativeInteger(model?.output_tokens),
          cache_creation_tokens: toNonNegativeInteger(model?.cache_creation_tokens),
          cache_read_tokens: toNonNegativeInteger(model?.cache_read_tokens),
          session_count: toNonNegativeInteger(model?.session_count),
        }))
      : [],
    by_date: Array.isArray(input.by_date)
      ? input.by_date.map((day: any) => ({
          date: typeof day?.date === "string" ? day.date : "",
          total_cost: toFiniteNumber(day?.total_cost),
          total_tokens: toNonNegativeInteger(day?.total_tokens),
          models_used: Array.isArray(day?.models_used)
            ? day.models_used.filter((entry: unknown): entry is string => typeof entry === "string")
            : [],
        }))
      : [],
    by_project: Array.isArray(input.by_project)
      ? input.by_project.map((project: any) => ({
          project_path: typeof project?.project_path === "string" ? project.project_path : "",
          project_name: typeof project?.project_name === "string" ? project.project_name : "",
          total_cost: toFiniteNumber(project?.total_cost),
          total_tokens: toNonNegativeInteger(project?.total_tokens),
          session_count: toNonNegativeInteger(project?.session_count),
          last_used: typeof project?.last_used === "string" ? project.last_used : "",
        }))
      : [],
  };
}

function sanitizeSessionStats(raw: unknown): ProjectUsage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((session: any) => ({
    project_path: typeof session?.project_path === "string" ? session.project_path : "",
    project_name: typeof session?.project_name === "string" ? session.project_name : "",
    total_cost: toFiniteNumber(session?.total_cost),
    total_tokens: toNonNegativeInteger(session?.total_tokens),
    session_count: toNonNegativeInteger(session?.session_count),
    last_used: typeof session?.last_used === "string" ? session.last_used : "",
  }));
}

/**
 * Optimized UsageDashboard component with caching and progressive loading
 */
export const UsageDashboard: React.FC<UsageDashboardProps> = ({ }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [sessionStats, setSessionStats] = useState<ProjectUsage[] | null>(null);
  const [sessionStatsLoading, setSessionStatsLoading] = useState(false);
  const [sessionStatsError, setSessionStatsError] = useState<string | null>(null);
  const [usageIndexStatus, setUsageIndexStatus] = useState<UsageIndexStatus | null>(null);
  const [usageIndexError, setUsageIndexError] = useState<string | null>(null);
  const [selectedDateRange, setSelectedDateRange] = useState<"all" | "7d" | "30d">("7d");
  const [activeTab, setActiveTab] = useState("overview");
  const [hasLoadedTabs, setHasLoadedTabs] = useState<Set<string>>(new Set(["overview"]));
  const previousIndexState = useRef<string | null>(null);
  
  // Pagination states
  const [projectsPage, setProjectsPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // Memoized formatters to prevent recreation on each render
  const formatCurrency = useMemo(() => (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }, []);

  const formatNumber = useMemo(() => (num: number): string => {
    return new Intl.NumberFormat('en-US').format(num);
  }, []);

  const formatTokens = useMemo(() => (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return formatNumber(num);
  }, [formatNumber]);

  const getModelDisplayName = useCallback((model: string): string => {
    const modelMap: Record<string, string> = {
      "claude-4-opus": "Opus 4",
      "claude-4-sonnet": "Sonnet 4",
      "claude-3.5-sonnet": "Sonnet 3.5",
      "claude-3-opus": "Opus 3",
    };
    return modelMap[model] || model;
  }, []);

  const parseSafeDate = useCallback((value: string): Date | null => {
    const parsed = new Date(value.includes('T') ? value : value.replace(/-/g, '/'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, []);

  // Function to get cached data or null
  const getCachedData = useCallback((key: string) => {
    const cached = dataCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    return null;
  }, []);

  // Function to set cached data
  const setCachedData = useCallback((key: string, data: any) => {
    dataCache.set(key, { data, timestamp: Date.now() });
  }, []);

  const loadUsageStats = useCallback(async () => {
    const cacheKey = `usage-${selectedDateRange}`;
    logWorkspaceEvent({
      category: 'state_action',
      action: 'usage_dashboard_load_start',
      payload: { selectedDateRange },
    });
    
    // Check cache first
    const cachedStats = getCachedData(`${cacheKey}-stats`);
    if (cachedStats) {
      logWorkspaceEvent({
        category: 'state_action',
        action: 'usage_dashboard_load_cache_hit',
        payload: { selectedDateRange },
      });
      setStats(cachedStats);
      setLoading(false);
      return;
    }

    try {
      // Don't show loading spinner if we have cached data for a different range
      if (!stats && !sessionStats) {
        setLoading(true);
      }
      setError(null);

      let statsData: UsageStats;
      
      if (selectedDateRange === "all") {
        const statsResult = await api.getUsageStats();
        statsData = sanitizeUsageStats(statsResult);
      } else {
        const endDate = new Date();
        const startDate = new Date();
        const days = selectedDateRange === "7d" ? 7 : 30;
        startDate.setDate(startDate.getDate() - days);

        const statsResult = await api.getUsageByDateRange(
          startDate.toISOString(),
          endDate.toISOString()
        );
        
        statsData = sanitizeUsageStats(statsResult);
      }
      
      // Update state
      setStats(statsData);
      logWorkspaceEvent({
        category: 'state_action',
        action: 'usage_dashboard_load_success',
        payload: {
          selectedDateRange,
          models: statsData.by_model.length,
          projects: statsData.by_project.length,
          sessions: sessionStats?.length || 0,
          dates: statsData.by_date.length,
        },
      });
      
      // Cache the data
      setCachedData(`${cacheKey}-stats`, statsData);
    } catch (err: any) {
      console.error("Failed to load usage stats:", err);
      logWorkspaceEvent({
        category: 'error',
        action: 'usage_dashboard_load_failed',
        message: err instanceof Error ? err.message : String(err),
        payload: { selectedDateRange },
      });
      setError("Failed to load usage statistics. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [selectedDateRange, getCachedData, setCachedData, stats, sessionStats]);

  const loadSessionStats = useCallback(async () => {
    if (sessionStatsLoading) return;

    const cacheKey = `usage-${selectedDateRange}-sessions`;
    const cachedSessions = getCachedData(cacheKey);
    if (cachedSessions) {
      setSessionStats(cachedSessions);
      setSessionStatsError(null);
      return;
    }

    setSessionStatsLoading(true);
    setSessionStatsError(null);
    logWorkspaceEvent({
      category: 'state_action',
      action: 'usage_sessions_load_start',
      payload: { selectedDateRange },
    });

    try {
      let result: ProjectUsage[];

      if (selectedDateRange === "all") {
        result = sanitizeSessionStats(await api.getSessionStats(undefined, undefined, undefined, 500, 0));
      } else {
        const endDate = new Date();
        const startDate = new Date();
        const days = selectedDateRange === "7d" ? 7 : 30;
        startDate.setDate(startDate.getDate() - days);

        const formatDateForApi = (date: Date) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}${month}${day}`;
        };

        result = sanitizeSessionStats(
          await api.getSessionStats(
            formatDateForApi(startDate),
            formatDateForApi(endDate),
            'desc',
            500,
            0,
          )
        );
      }

      setSessionStats(result);
      setCachedData(cacheKey, result);
      logWorkspaceEvent({
        category: 'state_action',
        action: 'usage_sessions_load_success',
        payload: { selectedDateRange, sessions: result.length },
      });
    } catch (err: any) {
      console.error("Failed to load session stats:", err);
      const message = err instanceof Error ? err.message : String(err);
      setSessionStatsError("Failed to load session statistics. Please try again.");
      logWorkspaceEvent({
        category: 'error',
        action: 'usage_sessions_load_failed',
        message,
        payload: { selectedDateRange },
      });
    } finally {
      setSessionStatsLoading(false);
    }
  }, [getCachedData, selectedDateRange, sessionStatsLoading, setCachedData]);

  useEffect(() => {
    logWorkspaceEvent({
      category: 'state_action',
      action: 'usage_dashboard_mounted',
    });
    return () => {
      logWorkspaceEvent({
        category: 'state_action',
        action: 'usage_dashboard_unmounted',
      });
    };
  }, []);

  const refreshUsageIndexStatus = useCallback(async () => {
    try {
      const status = await api.getUsageIndexStatus();
      setUsageIndexStatus(status);
      setUsageIndexError(null);
      return status;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setUsageIndexError(message);
      return null;
    }
  }, []);

  const startUsageIndexSync = useCallback(async () => {
    try {
      const status = await api.startUsageIndexSync();
      setUsageIndexStatus(status);
      setUsageIndexError(null);
      return status;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setUsageIndexError(message);
      return null;
    }
  }, []);

  const cancelUsageIndexSync = useCallback(async () => {
    try {
      const status = await api.cancelUsageIndexSync();
      setUsageIndexStatus(status);
      setUsageIndexError(null);
      return status;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setUsageIndexError(message);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      await refreshUsageIndexStatus();
      if (!cancelled) {
        await startUsageIndexSync();
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [refreshUsageIndexStatus, startUsageIndexSync]);

  useEffect(() => {
    if (usageIndexStatus?.state !== "indexing") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshUsageIndexStatus();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshUsageIndexStatus, usageIndexStatus?.state]);

  useEffect(() => {
    const currentState = usageIndexStatus?.state ?? null;
    if (previousIndexState.current === "indexing" && currentState === "idle") {
      void loadUsageStats();
      if (activeTab === "sessions") {
        void loadSessionStats();
      }
    }
    previousIndexState.current = currentState;
  }, [activeTab, loadSessionStats, loadUsageStats, usageIndexStatus?.state]);

  // Load data on mount and when date range changes
  useEffect(() => {
    // Reset pagination when date range changes
    setProjectsPage(1);
    setSessionsPage(1);
    setSessionStats(null);
    setSessionStatsError(null);
    loadUsageStats();
  }, [loadUsageStats])

  const usageIndexProgress = useMemo(() => {
    if (!usageIndexStatus || usageIndexStatus.files_total === 0) {
      return 0;
    }
    return Math.min(
      100,
      Math.round((usageIndexStatus.files_processed / usageIndexStatus.files_total) * 100)
    );
  }, [usageIndexStatus]);

  useEffect(() => {
    if (activeTab === "sessions" && sessionStats === null && !sessionStatsLoading) {
      loadSessionStats();
    }
  }, [activeTab, loadSessionStats, sessionStats, sessionStatsLoading]);

  // Preload adjacent tabs when idle
  useEffect(() => {
    if (!stats || loading) return;
    
    const tabOrder = ["overview", "models", "projects", "sessions", "timeline"];
    const currentIndex = tabOrder.indexOf(activeTab);
    
    // Use requestIdleCallback if available, otherwise setTimeout
    const schedulePreload = (callback: () => void) => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout: 2000 });
      } else {
        setTimeout(callback, 100);
      }
    };
    
    // Preload adjacent tabs
    schedulePreload(() => {
      if (currentIndex > 0) {
        setHasLoadedTabs(prev => new Set([...prev, tabOrder[currentIndex - 1]]));
      }
      if (currentIndex < tabOrder.length - 1) {
        setHasLoadedTabs(prev => new Set([...prev, tabOrder[currentIndex + 1]]));
      }
    });
  }, [activeTab, stats, loading])

  // Memoize expensive computations
  const summaryCards = useMemo(() => {
    if (!stats) return null;

    const nonCacheTokens = stats.total_input_tokens + stats.total_output_tokens;
    const cacheTokens = stats.total_cache_creation_tokens + stats.total_cache_read_tokens;
    const cacheShare = stats.total_tokens > 0
      ? Math.round((cacheTokens / stats.total_tokens) * 100)
      : 0;
    
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Total Cost</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatCurrency(stats.total_cost)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Includes cache-adjusted pricing
            </p>
          </div>
        </Card>

        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Total Sessions</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatNumber(stats.total_sessions)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Unique session IDs
            </p>
          </div>
        </Card>

        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Non-Cache Tokens</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatTokens(nonCacheTokens)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Input + output ({100 - cacheShare}% of total)
            </p>
          </div>
        </Card>

        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Cache Tokens</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatTokens(cacheTokens)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Cache write + read ({cacheShare}% of total)
            </p>
          </div>
        </Card>

        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Total Tokens (Incl Cache)</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatTokens(stats.total_tokens)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Non-cache + cache combined
            </p>
          </div>
        </Card>

        <Card className="min-w-0 rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-3.5 shadow-none shimmer-hover">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.045em] text-muted-foreground">Avg Cost / Session</p>
            <p className="mt-1 truncate text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
              {formatCurrency(
                stats.total_sessions > 0 
                  ? stats.total_cost / stats.total_sessions 
                  : 0
              )}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Cost / unique session
            </p>
          </div>
        </Card>
      </div>

        <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-muted/20 p-3.5 shadow-none">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">How cache tokens work</p>
              <p className="text-xs text-muted-foreground">
                Cache write/read tokens are reused prompt context. They are counted in total tokens, but billed differently from normal input/output tokens.
              </p>
              <p className="text-xs text-muted-foreground">
                Current range: {cacheShare}% cache tokens, {100 - cacheShare}% non-cache tokens.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }, [stats, formatCurrency, formatNumber, formatTokens]);

  // Memoize the most used models section
  const mostUsedModels = useMemo(() => {
    if (!stats?.by_model) return null;
    
    return stats.by_model.slice(0, 3).map((model) => (
      <div key={model.model} className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Badge variant="outline" className="text-caption">
            {getModelDisplayName(model.model)}
          </Badge>
          <span className="text-caption text-muted-foreground">
            {model.session_count} sessions
          </span>
        </div>
        <span className="text-body-small font-medium">
          {formatCurrency(model.total_cost)}
        </span>
      </div>
    ));
  }, [stats, formatCurrency, getModelDisplayName]);

  // Memoize top projects section
  const topProjects = useMemo(() => {
    if (!stats?.by_project) return null;
    
    return stats.by_project.slice(0, 3).map((project) => (
      <div key={project.project_path} className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-body-small font-medium truncate max-w-[220px]" title={project.project_path}>
            {project.project_path.split('/').slice(-2).join('/') || project.project_name || 'Unknown project'}
          </span>
          <span className="text-caption text-muted-foreground">
            {project.session_count} sessions
          </span>
        </div>
        <span className="text-body-small font-medium">
          {formatCurrency(project.total_cost)}
        </span>
      </div>
    ));
  }, [stats, formatCurrency]);

  // Memoize timeline chart data
  const timelineChartData = useMemo(() => {
    if (!stats?.by_date || stats.by_date.length === 0) return null;
    
    const maxCost = Math.max(...stats.by_date.map(d => d.total_cost), 0);
    const halfMaxCost = maxCost / 2;
    const reversedData = stats.by_date.slice().reverse();
    
    return {
      maxCost,
      halfMaxCost,
      reversedData,
      bars: reversedData.map(day => ({
        ...day,
        heightPercent: maxCost > 0 ? (day.total_cost / maxCost) * 100 : 0,
        parsedDate: parseSafeDate(day.date),
      }))
    };
  }, [stats?.by_date, parseSafeDate]);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col">
        {/* Header */}
        <div className="px-5 pb-3 pt-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">Usage Dashboard</h1>
              <p className="mt-1 text-[1.1rem] text-muted-foreground">
                Track your Claude Code usage and costs
              </p>
            </div>
            {/* Date Range Filter */}
            <div className="flex flex-col gap-1.5 xl:items-end">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Filter className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Date Range</span>
              </div>
              <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-[var(--color-chrome-border)] bg-[var(--color-chrome-surface)] p-1">
                {(["7d", "30d", "all"] as const).map((range) => (
                  <Button
                    key={range}
                    variant="ghost"
                    size="sm"
                    className={selectedDateRange === range
                      ? "h-8 min-w-[6.5rem] justify-center rounded-md border border-[var(--color-chrome-border)] bg-background px-3 text-xs font-medium text-foreground shadow-xs"
                      : "h-8 min-w-[6.5rem] justify-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground"}
                    onClick={() => setSelectedDateRange(range)}
                    disabled={loading}
                  >
                    {range === "all" ? "All Time" : range === "7d" ? "Last 7 Days" : "Last 30 Days"}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {(usageIndexStatus || usageIndexError) && (
            <div className="mb-3 rounded-md border border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-2.5 shadow-none">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold tracking-[0.01em]">
                    {usageIndexStatus?.state === "indexing"
                      ? "Indexing usage history..."
                      : usageIndexStatus?.state === "error"
                        ? "Usage index error"
                        : "Usage index ready"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {usageIndexStatus?.state === "error" && usageIndexStatus.last_error
                      ? usageIndexStatus.last_error
                      : usageIndexError
                      ? usageIndexError
                      : usageIndexStatus?.state === "indexing"
                        ? `Processed ${usageIndexStatus.files_processed} of ${usageIndexStatus.files_total} files (${usageIndexProgress}%)`
                        : usageIndexStatus?.last_completed_at
                          ? `Last synced ${new Date(usageIndexStatus.last_completed_at).toLocaleString()}`
                          : "No completed sync yet"}
                  </p>
                  {(usageIndexStatus?.state === "error" || usageIndexError) && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Log: ~/.opcode-usage-debug.log
                    </p>
                  )}
                  {usageIndexStatus?.current_file && usageIndexStatus.state === "indexing" && (
                    <p className="mt-0.5 max-w-full truncate text-[11px] text-muted-foreground" title={usageIndexStatus.current_file}>
                      {usageIndexStatus.current_file}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {usageIndexStatus?.state === "indexing" ? (
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => void cancelUsageIndexSync()}>
                      Cancel
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => void startUsageIndexSync()}>
                      Refresh
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/50 text-body-small text-destructive">
              {error}
              <Button onClick={() => loadUsageStats()} size="sm" className="ml-4">
                Try Again
              </Button>
            </div>
          ) : stats ? (
            <div className="space-y-4">
              {stats.total_sessions === 0 && usageIndexStatus?.state === "indexing" && (
                <Card className="p-4">
                  <p className="text-sm text-muted-foreground">Indexing usage history...</p>
                </Card>
              )}

              {/* Summary Cards */}
              {summaryCards}

              {/* Tabs for different views */}
              <Tabs value={activeTab} onValueChange={(value) => {
                setActiveTab(value);
                setHasLoadedTabs(prev => new Set([...prev, value]));
                if (value === "sessions" && sessionStats === null && !sessionStatsLoading) {
                  void loadSessionStats();
                }
              }} className="w-full">
                <TabsList className="mb-3 grid h-auto w-full grid-cols-2 gap-1 rounded-md border border-[var(--color-chrome-border)]/80 p-0.5 shadow-none sm:grid-cols-3 lg:grid-cols-5">
                  <TabsTrigger value="overview" className="px-2 py-1.5 text-xs sm:px-3 sm:text-sm">Overview</TabsTrigger>
                  <TabsTrigger value="models" className="px-2 py-1.5 text-xs sm:px-3 sm:text-sm">By Model</TabsTrigger>
                  <TabsTrigger value="projects" className="px-2 py-1.5 text-xs sm:px-3 sm:text-sm">By Project</TabsTrigger>
                  <TabsTrigger value="sessions" className="px-2 py-1.5 text-xs sm:px-3 sm:text-sm">By Session</TabsTrigger>
                  <TabsTrigger value="timeline" className="px-2 py-1.5 text-xs sm:px-3 sm:text-sm">Timeline</TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="mt-3 space-y-3">
                  <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                    <h3 className="text-label mb-2">Token Breakdown</h3>
                    <p className="mb-4 text-xs text-muted-foreground">
                      Input/output are fresh model work. Cache write/read are reused prompt-context paths.
                    </p>
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div>
                        <p className="text-caption text-muted-foreground">Input Tokens</p>
                        <p className="text-xl font-semibold leading-none tracking-tight">{formatTokens(stats.total_input_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">Output Tokens</p>
                        <p className="text-xl font-semibold leading-none tracking-tight">{formatTokens(stats.total_output_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">Cache Write</p>
                        <p className="text-xl font-semibold leading-none tracking-tight">{formatTokens(stats.total_cache_creation_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">Cache Read</p>
                        <p className="text-xl font-semibold leading-none tracking-tight">{formatTokens(stats.total_cache_read_tokens)}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Quick Stats */}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                      <h3 className="text-label mb-2">Most Used Models</h3>
                      <p className="mb-4 text-xs text-muted-foreground">
                        Session counts are unique per model and are not additive across models.
                      </p>
                      <div className="space-y-3">
                        {mostUsedModels}
                      </div>
                    </Card>

                    <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                      <h3 className="text-label mb-4">Top Projects</h3>
                      <div className="space-y-3">
                        {topProjects}
                      </div>
                    </Card>
                  </div>
                </TabsContent>

                {/* Models Tab - Lazy render and cache */}
                <TabsContent value="models" className="mt-3 space-y-3">
                  {hasLoadedTabs.has("models") && stats && (
                    <div style={{ display: activeTab === "models" ? "block" : "none" }}>
                      <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                        <h3 className="text-sm font-semibold mb-1">Usage by Model</h3>
                        <p className="mb-4 text-xs text-muted-foreground">
                          A single session can appear under multiple models if it switched models.
                        </p>
                        <div className="space-y-4">
                          {stats.by_model.map((model) => (
                          <div key={model.model} className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-3">
                                <Badge 
                                  variant="outline" 
                                  className="text-xs"
                                >
                                  {getModelDisplayName(model.model)}
                                </Badge>
                                <span className="text-sm text-muted-foreground">
                                  {model.session_count} sessions
                                </span>
                              </div>
                              <span className="text-sm font-semibold">
                                {formatCurrency(model.total_cost)}
                              </span>
                            </div>
                            <div className="grid grid-cols-4 gap-2 text-xs">
                              <div>
                                <span className="text-muted-foreground">Input: </span>
                                <span className="font-medium">{formatTokens(model.input_tokens)}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Output: </span>
                                <span className="font-medium">{formatTokens(model.output_tokens)}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Cache W: </span>
                                <span className="font-medium">{formatTokens(model.cache_creation_tokens)}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Cache R: </span>
                                <span className="font-medium">{formatTokens(model.cache_read_tokens)}</span>
                              </div>
                            </div>
                            </div>
                          ))}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Projects Tab - Lazy render and cache */}
                <TabsContent value="projects" className="mt-3 space-y-3">
                  {hasLoadedTabs.has("projects") && stats && (
                    <div style={{ display: activeTab === "projects" ? "block" : "none" }}>
                      <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold">Usage by Project</h3>
                        <span className="text-xs text-muted-foreground">
                          {stats.by_project.length} total projects
                        </span>
                      </div>
                      <div className="space-y-3">
                        {(() => {
                          const startIndex = (projectsPage - 1) * ITEMS_PER_PAGE;
                          const endIndex = startIndex + ITEMS_PER_PAGE;
                          const paginatedProjects = stats.by_project.slice(startIndex, endIndex);
                          const totalPages = Math.ceil(stats.by_project.length / ITEMS_PER_PAGE);
                          
                          return (
                            <>
                              {paginatedProjects.map((project) => {
                                const avgCostPerSession = project.session_count > 0
                                  ? project.total_cost / project.session_count
                                  : 0;

                                return (
                                  <div key={project.project_path} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                                  <div className="flex flex-col truncate">
                                    <span className="text-sm font-medium truncate" title={project.project_path}>
                                      {project.project_path}
                                    </span>
                                    <div className="flex items-center space-x-3 mt-1">
                                      <span className="text-caption text-muted-foreground">
                                        {project.session_count} sessions
                                      </span>
                                      <span className="text-caption text-muted-foreground">
                                        {formatTokens(project.total_tokens)} tokens
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm font-semibold">{formatCurrency(project.total_cost)}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatCurrency(avgCostPerSession)}/session
                                    </p>
                                  </div>
                                </div>
                                );
                              })}
                              
                              {/* Pagination Controls */}
                              {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4">
                                  <span className="text-xs text-muted-foreground">
                                    Showing {startIndex + 1}-{Math.min(endIndex, stats.by_project.length)} of {stats.by_project.length}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setProjectsPage(prev => Math.max(1, prev - 1))}
                                      disabled={projectsPage === 1}
                                    >
                                      <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                    <span className="text-sm">
                                      Page {projectsPage} of {totalPages}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setProjectsPage(prev => Math.min(totalPages, prev + 1))}
                                      disabled={projectsPage === totalPages}
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          );
                          })()}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Sessions Tab - Lazy render and cache */}
                <TabsContent value="sessions" className="mt-3 space-y-3">
                  {hasLoadedTabs.has("sessions") && (
                    <div style={{ display: activeTab === "sessions" ? "block" : "none" }}>
                      <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold">Usage by Session</h3>
                        {sessionStats && sessionStats.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {sessionStats.length} total sessions
                          </span>
                        )}
                      </div>
                      <div className="space-y-3">
                        {sessionStatsLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : sessionStatsError ? (
                          <div className="text-center py-8 text-sm text-destructive">
                            {sessionStatsError}
                            <Button onClick={() => void loadSessionStats()} size="sm" className="ml-3">
                              Retry
                            </Button>
                          </div>
                        ) : sessionStats && sessionStats.length > 0 ? (() => {
                          const startIndex = (sessionsPage - 1) * ITEMS_PER_PAGE;
                          const endIndex = startIndex + ITEMS_PER_PAGE;
                          const paginatedSessions = sessionStats.slice(startIndex, endIndex);
                          const totalPages = Math.ceil(sessionStats.length / ITEMS_PER_PAGE);
                          
                          return (
                            <>
                              {paginatedSessions.map((session, index) => {
                                const sessionPath = session.project_path || '';
                                const displayPath = sessionPath
                                  ? sessionPath.split('/').slice(-2).join('/')
                                  : 'Unknown project';
                                const parsedLastUsed = session.last_used ? parseSafeDate(session.last_used) : null;

                                return (
                                  <div key={`${session.project_path}-${session.project_name}-${startIndex + index}`} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                                  <div className="flex flex-col">
                                    <div className="flex items-center space-x-2">
                                      <Briefcase className="h-4 w-4 text-muted-foreground" />
                                      <span className="text-xs font-mono text-muted-foreground truncate max-w-[200px]" title={sessionPath || undefined}>
                                        {displayPath}
                                      </span>
                                    </div>
                                    <span className="text-sm font-medium mt-1">
                                      {session.project_name}
                                    </span>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm font-semibold">{formatCurrency(session.total_cost)}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {parsedLastUsed ? parsedLastUsed.toLocaleDateString() : 'N/A'}
                                    </p>
                                  </div>
                                </div>
                                );
                              })}
                              
                              {/* Pagination Controls */}
                              {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4">
                                  <span className="text-xs text-muted-foreground">
                                    Showing {startIndex + 1}-{Math.min(endIndex, sessionStats.length)} of {sessionStats.length}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setSessionsPage(prev => Math.max(1, prev - 1))}
                                      disabled={sessionsPage === 1}
                                    >
                                      <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                    <span className="text-sm">
                                      Page {sessionsPage} of {totalPages}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setSessionsPage(prev => Math.min(totalPages, prev + 1))}
                                      disabled={sessionsPage === totalPages}
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })() : (
                          <div className="text-center py-8 text-sm text-muted-foreground">
                            No session data available for the selected period
                          </div>
                          )}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Timeline Tab - Lazy render and cache */}
                <TabsContent value="timeline" className="mt-3 space-y-3">
                  {hasLoadedTabs.has("timeline") && stats && (
                    <div style={{ display: activeTab === "timeline" ? "block" : "none" }}>
                      <Card className="rounded-md border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-active)] p-4 shadow-none">
                      <h3 className="text-sm font-semibold mb-6 flex items-center space-x-2">
                        <Calendar className="h-4 w-4" />
                        <span>Daily Usage</span>
                      </h3>
                      {timelineChartData ? (
                        <div className="relative pl-8 pr-4">
                          {/* Y-axis labels */}
                          <div className="absolute left-0 top-0 bottom-8 flex flex-col justify-between text-xs text-muted-foreground">
                            <span>{formatCurrency(timelineChartData.maxCost)}</span>
                            <span>{formatCurrency(timelineChartData.halfMaxCost)}</span>
                            <span>{formatCurrency(0)}</span>
                          </div>
                          
                          {/* Chart container */}
                          <div className="flex items-end space-x-2 h-64 border-l border-b border-border pl-4">
                            {timelineChartData.bars.map((day, index) => {
                              const formattedDate = day.parsedDate
                                ? day.parsedDate.toLocaleDateString('en-US', {
                                  weekday: 'short',
                                  month: 'short',
                                  day: 'numeric'
                                })
                                : day.date;

                              const xLabel = day.parsedDate
                                ? day.parsedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                                : day.date;

                              return (
                                <div key={`${day.date}-${index}`} className="flex-1 h-full flex flex-col items-center justify-end group relative">
                                  {/* Tooltip */}
                                  <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
                                    <div className="bg-background border border-border rounded-lg shadow-lg p-3 whitespace-nowrap">
                                      <p className="text-sm font-semibold">{formattedDate}</p>
                                      <p className="text-sm text-muted-foreground mt-1">
                                        Cost: {formatCurrency(day.total_cost)}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {formatTokens(day.total_tokens)} tokens
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {day.models_used.length} model{day.models_used.length !== 1 ? 's' : ''}
                                      </p>
                                    </div>
                                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                                      <div className="border-4 border-transparent border-t-border"></div>
                                    </div>
                                  </div>
                                  
                                  {/* Bar */}
                                  <div 
                                    className="w-full bg-primary hover:opacity-80 transition-opacity rounded-t cursor-pointer"
                                    style={{ height: `${day.heightPercent}%` }}
                                  />
                                  
                                  {/* X-axis label – absolutely positioned below the bar */}
                                  <div
                                    className="absolute left-1/2 top-full mt-2 -translate-x-1/2 text-xs text-muted-foreground whitespace-nowrap pointer-events-none"
                                  >
                                    {xLabel}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          
                          {/* X-axis label */}
                          <div className="mt-10 text-center text-xs text-muted-foreground">
                            Daily Usage Over Time
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-8 text-sm text-muted-foreground">
                          No usage data available for the selected period
                        </div>
                        )}
                      </Card>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
