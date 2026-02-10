import type {
  AgentAttentionKind,
  AgentAttentionSource,
  FocusContext,
} from "@/services/agentAttention";

export const NOTIFICATION_HISTORY_CHANGED_EVENT =
  "codeinterfacex:notification-history-changed";

export interface NotificationRecord {
  id: string;
  kind: AgentAttentionKind;
  source: AgentAttentionSource;
  title: string;
  body: string;
  terminalTabId?: string;
  focusContext: FocusContext;
  timestamp: number;
  read: boolean;
}

class NotificationHistory {
  private records: NotificationRecord[] = [];
  private readonly maxSize = 100;

  add(record: NotificationRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxSize) {
      this.records = this.records.slice(this.records.length - this.maxSize);
    }
    this.dispatchChange();
  }

  getAll(): NotificationRecord[] {
    return [...this.records];
  }

  getUnread(): NotificationRecord[] {
    return this.records.filter((r) => !r.read);
  }

  getUnreadCount(): number {
    return this.records.filter((r) => !r.read).length;
  }

  markRead(id: string): void {
    const record = this.records.find((r) => r.id === id);
    if (record && !record.read) {
      record.read = true;
      this.dispatchChange();
    }
  }

  markAllRead(): void {
    let changed = false;
    for (const record of this.records) {
      if (!record.read) {
        record.read = true;
        changed = true;
      }
    }
    if (changed) this.dispatchChange();
  }

  clear(): void {
    if (this.records.length === 0) return;
    this.records = [];
    this.dispatchChange();
  }

  private dispatchChange(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(NOTIFICATION_HISTORY_CHANGED_EVENT)
    );
  }
}

export const notificationHistory = new NotificationHistory();
