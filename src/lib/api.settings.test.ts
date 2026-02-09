import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apiAdapter", () => ({
  apiCall: vi.fn(),
}));

import { api } from "@/lib/api";
import { apiCall } from "@/lib/apiAdapter";

const apiCallMock = vi.mocked(apiCall);

describe("api.getSetting", () => {
  beforeEach(() => {
    localStorage.clear();
    apiCallMock.mockReset();
  });

  it("returns cached localStorage value without hitting storage_read_table", async () => {
    localStorage.setItem("app_setting:theme", "cached-dark");

    const value = await api.getSetting("theme");

    expect(value).toBe("cached-dark");
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it("reads from storage_read_table rows and mirrors value into localStorage", async () => {
    apiCallMock.mockResolvedValue({
      table_name: "app_settings",
      columns: [],
      rows: [
        { key: "theme", value: "db-dark" },
        { key: "plain_terminal_mode", value: "true" },
      ],
      total_rows: 2,
      page: 1,
      page_size: 1000,
      total_pages: 1,
    });

    const value = await api.getSetting("theme");

    expect(apiCallMock).toHaveBeenCalledWith("storage_read_table", {
      tableName: "app_settings",
      page: 1,
      pageSize: 1000,
      searchQuery: undefined,
    });
    expect(value).toBe("db-dark");
    expect(localStorage.getItem("app_setting:theme")).toBe("db-dark");
  });

  it("returns null when key is missing", async () => {
    apiCallMock.mockResolvedValue({
      table_name: "app_settings",
      columns: [],
      rows: [{ key: "other", value: "x" }],
      total_rows: 1,
      page: 1,
      page_size: 1000,
      total_pages: 1,
    });

    const value = await api.getSetting("theme");

    expect(value).toBeNull();
    expect(localStorage.getItem("app_setting:theme")).toBeNull();
  });

  it("bypasses cache when fresh option is enabled", async () => {
    localStorage.setItem("app_setting:theme", "cached-dark");
    apiCallMock.mockResolvedValue({
      table_name: "app_settings",
      columns: [],
      rows: [{ key: "theme", value: "db-dark" }],
      total_rows: 1,
      page: 1,
      page_size: 1000,
      total_pages: 1,
    });

    const value = await api.getSetting("theme", { fresh: true });

    expect(value).toBe("db-dark");
    expect(apiCallMock).toHaveBeenCalledWith("storage_read_table", {
      tableName: "app_settings",
      page: 1,
      pageSize: 1000,
      searchQuery: undefined,
    });
    expect(localStorage.getItem("app_setting:theme")).toBe("db-dark");
  });
});
