import React, { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps {
  /**
   * Content for the left pane
   */
  left: React.ReactNode;
  /**
   * Content for the right pane
   */
  right: React.ReactNode;
  /**
   * Initial split position as percentage (0-100)
   * @default 50
   */
  initialSplit?: number;
  /**
   * Minimum width for left pane in pixels
   * @default 200
   */
  minLeftWidth?: number;
  /**
   * Minimum width for right pane in pixels
   * @default 200
   */
  minRightWidth?: number;
  /**
   * Callback when split position changes
   */
  onSplitChange?: (position: number) => void;
  /**
   * Collapse the left pane while keeping split-pane mounted
   * @default false
   */
  leftCollapsed?: boolean;
  /**
   * Optional className for styling
   */
  className?: string;
}

/**
 * Resizable split pane component for side-by-side layouts
 * 
 * @example
 * <SplitPane
 *   left={<div>Left content</div>}
 *   right={<div>Right content</div>}
 *   initialSplit={60}
 *   onSplitChange={(pos) => console.log('Split at', pos)}
 * />
 */
export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  initialSplit = 50,
  minLeftWidth = 200,
  minRightWidth = 200,
  onSplitChange,
  leftCollapsed = false,
  className,
}) => {
  const GUTTER_WIDTH = 12;
  const [splitPosition, setSplitPosition] = useState(initialSplit);
  const [isDragging, setIsDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartLeftPx = useRef(0);
  const animationFrameRef = useRef<number | null>(null);

  const getLeftBounds = useCallback(
    (effectiveWidth: number) => {
      if (effectiveWidth <= 0) {
        return { min: 0, max: 0 };
      }

      const min = Math.min(minLeftWidth, effectiveWidth);
      const max = Math.max(0, effectiveWidth - Math.min(minRightWidth, effectiveWidth));

      if (max < min) {
        return { min: max, max };
      }

      return { min, max };
    },
    [minLeftWidth, minRightWidth]
  );

  const clampLeftPixels = useCallback(
    (candidate: number, effectiveWidth: number) => {
      const { min, max } = getLeftBounds(effectiveWidth);
      return Math.min(Math.max(candidate, min), max);
    },
    [getLeftBounds]
  );

  const toSplitPercent = useCallback((leftPixels: number, effectiveWidth: number): number => {
    if (effectiveWidth <= 0) {
      return 0;
    }
    return (leftPixels / effectiveWidth) * 100;
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const measure = () => {
      setContainerWidth(node.clientWidth);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    setSplitPosition(initialSplit);
  }, [initialSplit]);

  const effectiveWidth = Math.max(0, containerWidth - (leftCollapsed ? 0 : GUTTER_WIDTH));
  const unclampedLeftPx = (splitPosition / 100) * effectiveWidth;
  const leftPx = leftCollapsed
    ? 0
    : clampLeftPixels(Number.isFinite(unclampedLeftPx) ? unclampedLeftPx : 0, effectiveWidth);
  const gutterPx = leftCollapsed ? 0 : GUTTER_WIDTH;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (leftCollapsed) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartLeftPx.current = leftPx;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (leftCollapsed || !isDragging || !containerRef.current) return;

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      animationFrameRef.current = requestAnimationFrame(() => {
        const fullWidth = containerRef.current?.clientWidth ?? 0;
        const currentEffectiveWidth = Math.max(0, fullWidth - GUTTER_WIDTH);
        const deltaX = e.clientX - dragStartX.current;
        const proposedLeftPx = dragStartLeftPx.current + deltaX;
        const clampedLeftPx = clampLeftPixels(proposedLeftPx, currentEffectiveWidth);
        const nextSplit = toSplitPercent(clampedLeftPx, currentEffectiveWidth);
        setSplitPosition(nextSplit);
        onSplitChange?.(nextSplit);
      });
    },
    [isDragging, leftCollapsed, clampLeftPixels, onSplitChange, toSplitPercent]
  );

  const handleMouseUp = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setIsDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    if (leftCollapsed && isDragging) {
      handleMouseUp();
      return;
    }

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, leftCollapsed]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (leftCollapsed) return;
    const currentEffectiveWidth = Math.max(0, containerWidth - GUTTER_WIDTH);
    const step = e.shiftKey ? 10 : 2;
    const { min, max } = getLeftBounds(currentEffectiveWidth);
    let nextLeftPx = leftPx;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        nextLeftPx = leftPx - step;
        break;
      case "ArrowRight":
        e.preventDefault();
        nextLeftPx = leftPx + step;
        break;
      case "Home":
        e.preventDefault();
        nextLeftPx = min;
        break;
      case "End":
        e.preventDefault();
        nextLeftPx = max;
        break;
      default:
        return;
    }

    const clampedLeftPx = clampLeftPixels(nextLeftPx, currentEffectiveWidth);
    const nextSplit = toSplitPercent(clampedLeftPx, currentEffectiveWidth);
    setSplitPosition(nextSplit);
    onSplitChange?.(nextSplit);
  };

  return (
    <div 
      ref={containerRef}
      className={cn("grid h-full w-full", className)}
      style={{
        gridTemplateRows: "minmax(0, 1fr)",
        gridTemplateColumns: `${Math.round(leftPx)}px ${gutterPx}px minmax(0, 1fr)`,
      }}
    >
      <div 
        className={cn(
          "relative min-w-0 overflow-hidden",
          leftCollapsed && "pointer-events-none"
        )}
        data-testid="split-pane-left"
      >
        {left}
      </div>

      <div
        className={cn(
          "relative h-full min-w-0",
          leftCollapsed ? "pointer-events-none" : "pointer-events-auto"
        )}
        data-testid="split-pane-gutter"
      >
        {!leftCollapsed && (
          <button
            type="button"
            className={cn(
              "group absolute inset-0 flex cursor-col-resize items-center justify-center bg-transparent p-0",
              "hover:bg-primary/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            )}
            onMouseDown={handleMouseDown}
            onKeyDown={handleKeyDown}
            role="separator"
            aria-label="Resize panes"
            aria-valuenow={Math.round(splitPosition)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className={cn(
                "h-full w-px bg-border transition-colors",
                isDragging ? "bg-primary" : "group-hover:bg-primary/50"
              )}
            />
          </button>
        )}
      </div>

      <div 
        className="relative min-w-0 overflow-hidden [contain:layout_paint]"
        data-testid="split-pane-right"
      >
        {right}
      </div>
    </div>
  );
};
