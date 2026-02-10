import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationHistory, NOTIFICATION_HISTORY_CHANGED_EVENT, type NotificationRecord } from "@/services/notificationHistory";

function makeRecord(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: crypto.randomUUID(),
    kind: "done",
    source: "provider_session",
    title: "Test",
    body: "Test body",
    focusContext: "unfocused",
    timestamp: Date.now(),
    read: false,
    ...overrides,
  };
}

describe("NotificationHistory", () => {
  beforeEach(() => {
    notificationHistory.clear();
  });

  afterEach(() => {
    notificationHistory.clear();
  });

  it("starts empty", () => {
    expect(notificationHistory.getAll()).toHaveLength(0);
    expect(notificationHistory.getUnread()).toHaveLength(0);
    expect(notificationHistory.getUnreadCount()).toBe(0);
  });

  it("adds and retrieves records", () => {
    notificationHistory.add(makeRecord({ body: "First" }));
    notificationHistory.add(makeRecord({ body: "Second" }));

    const all = notificationHistory.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].body).toBe("First");
    expect(all[1].body).toBe("Second");
  });

  it("tracks unread count", () => {
    notificationHistory.add(makeRecord({ read: false }));
    notificationHistory.add(makeRecord({ read: true }));
    notificationHistory.add(makeRecord({ read: false }));

    expect(notificationHistory.getUnreadCount()).toBe(2);
    expect(notificationHistory.getUnread()).toHaveLength(2);
  });

  it("marks a single record as read", () => {
    const record = makeRecord({ read: false });
    notificationHistory.add(record);

    notificationHistory.markRead(record.id);

    expect(notificationHistory.getUnreadCount()).toBe(0);
  });

  it("marks all as read", () => {
    notificationHistory.add(makeRecord({ read: false }));
    notificationHistory.add(makeRecord({ read: false }));
    notificationHistory.add(makeRecord({ read: false }));

    notificationHistory.markAllRead();

    expect(notificationHistory.getUnreadCount()).toBe(0);
  });

  it("clears all records", () => {
    notificationHistory.add(makeRecord());
    notificationHistory.add(makeRecord());

    notificationHistory.clear();

    expect(notificationHistory.getAll()).toHaveLength(0);
  });

  it("enforces max size ring buffer", () => {
    for (let i = 0; i < 110; i++) {
      notificationHistory.add(makeRecord({ body: `Record ${i}` }));
    }

    const all = notificationHistory.getAll();
    expect(all).toHaveLength(100);
    // Oldest records should be trimmed
    expect(all[0].body).toBe("Record 10");
    expect(all[99].body).toBe("Record 109");
  });

  it("returns defensive copies from getAll", () => {
    notificationHistory.add(makeRecord());
    const first = notificationHistory.getAll();
    const second = notificationHistory.getAll();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("dispatches change event on add", () => {
    const handler = vi.fn();
    window.addEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);

    notificationHistory.add(makeRecord());

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);
  });

  it("dispatches change event on markAllRead", () => {
    notificationHistory.add(makeRecord({ read: false }));

    const handler = vi.fn();
    window.addEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);

    notificationHistory.markAllRead();

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);
  });

  it("dispatches change event on clear", () => {
    notificationHistory.add(makeRecord());

    const handler = vi.fn();
    window.addEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);

    notificationHistory.clear();

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(NOTIFICATION_HISTORY_CHANGED_EVENT, handler);
  });
});
