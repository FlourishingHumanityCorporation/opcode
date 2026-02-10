import React, { useState, useEffect, useRef } from "react";
import { Bell, Check, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import {
  notificationHistory,
  NOTIFICATION_HISTORY_CHANGED_EVENT,
  type NotificationRecord,
} from "@/services/notificationHistory";

interface NotificationCenterProps {
  onNavigateToTerminal?: (terminalTabId: string) => void;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupByDay(
  records: NotificationRecord[]
): Map<string, NotificationRecord[]> {
  const grouped = new Map<string, NotificationRecord[]>();
  for (const record of records) {
    const key = new Date(record.timestamp).toDateString();
    const existing = grouped.get(key) ?? [];
    existing.push(record);
    grouped.set(key, existing);
  }
  return grouped;
}

function dayLabel(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  onNavigateToTerminal,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refresh = () => {
      setRecords(notificationHistory.getAll());
      setUnreadCount(notificationHistory.getUnreadCount());
    };
    refresh();

    window.addEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, refresh);
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleNotificationClick = (record: NotificationRecord) => {
    notificationHistory.markRead(record.id);
    if (record.terminalTabId && onNavigateToTerminal) {
      onNavigateToTerminal(record.terminalTabId);
    }
    setIsOpen(false);
  };

  const reversedRecords = [...records].reverse();
  const grouped = groupByDay(reversedRecords);

  const kindColorMap: Record<string, string> = {
    done: "text-green-400",
    needs_input: "text-amber-400",
    running: "text-blue-400",
  };

  return (
    <div className="relative" ref={panelRef}>
      <motion.button
        onClick={() => setIsOpen(!isOpen)}
        whileTap={{ scale: 0.97 }}
        transition={{ duration: 0.15 }}
        className="p-1 rounded-md text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)] transition-colors tauri-no-drag relative"
        aria-label="Notifications"
      >
        <Bell size={13} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-amber-500 text-[8px] font-bold text-white flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </motion.button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 bg-[var(--color-chrome-surface)] border border-[var(--color-chrome-border)] rounded-lg shadow-lg z-[250] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-chrome-border)]">
            <span className="text-xs font-medium text-[var(--color-chrome-text)]">
              Notifications
            </span>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={() => notificationHistory.markAllRead()}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/10"
                  title="Mark all read"
                >
                  <Check size={10} />
                  Read all
                </button>
              )}
              {records.length > 0 && (
                <button
                  onClick={() => notificationHistory.clear()}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/10"
                  title="Clear all"
                >
                  <Trash2 size={10} />
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1">
            {records.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              Array.from(grouped.entries()).map(([day, dayRecords]) => (
                <div key={day}>
                  <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground bg-accent/5 sticky top-0">
                    {dayLabel(day)}
                  </div>
                  {dayRecords.map((record) => (
                    <button
                      key={record.id}
                      onClick={() => handleNotificationClick(record)}
                      className={`w-full text-left px-3 py-2 hover:bg-accent/10 transition-colors border-b border-[var(--color-chrome-border)]/50 ${
                        record.read ? "opacity-60" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {!record.read && (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-[10px] font-medium ${
                                kindColorMap[record.kind] ?? "text-foreground"
                              }`}
                            >
                              {record.kind === "done"
                                ? "Done"
                                : record.kind === "needs_input"
                                  ? "Input needed"
                                  : "Running"}
                            </span>
                            <span className="text-[9px] text-muted-foreground">
                              {formatTimestamp(record.timestamp)}
                            </span>
                          </div>
                          <p className="text-[11px] text-foreground/80 truncate">
                            {record.body}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
