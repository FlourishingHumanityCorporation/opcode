import { beforeEach, describe, expect, it } from "vitest";
import { archiveLegacyOpcodeLocalStorageState } from "./rebrand";

const ARCHIVE_PREFIX = "codeinterfacex.archive.localStorage.";
const MARKER_KEY = "codeinterfacex.rebrand.v1.complete";

function listStorageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

describe("archiveLegacyOpcodeLocalStorageState", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("archives opcode-prefixed keys and marks completion", () => {
    window.localStorage.setItem("opcode.foo", "bar");
    window.localStorage.setItem("opcode:explorer:open:abc", "1");
    window.localStorage.setItem("other.key", "keep");

    archiveLegacyOpcodeLocalStorageState();

    expect(window.localStorage.getItem("opcode.foo")).toBeNull();
    expect(window.localStorage.getItem("opcode:explorer:open:abc")).toBeNull();
    expect(window.localStorage.getItem("other.key")).toBe("keep");
    expect(window.localStorage.getItem(MARKER_KEY)).not.toBeNull();

    const archiveKey = listStorageKeys().find((key) =>
      key.startsWith(ARCHIVE_PREFIX)
    );
    expect(archiveKey).toBeTruthy();

    const archivedPayload = JSON.parse(
      window.localStorage.getItem(archiveKey as string) || "{}"
    ) as { entries?: Record<string, string> };

    expect(archivedPayload.entries).toMatchObject({
      "opcode.foo": "bar",
      "opcode:explorer:open:abc": "1",
    });
  });

  it("is idempotent after the rebrand marker is set", () => {
    window.localStorage.setItem("opcode.foo", "bar");
    archiveLegacyOpcodeLocalStorageState();

    const archiveCountAfterFirstRun = listStorageKeys().filter((key) =>
      key.startsWith(ARCHIVE_PREFIX)
    ).length;

    window.localStorage.setItem("opcode.bar", "baz");
    archiveLegacyOpcodeLocalStorageState();

    const archiveCountAfterSecondRun = listStorageKeys().filter((key) =>
      key.startsWith(ARCHIVE_PREFIX)
    ).length;

    expect(archiveCountAfterSecondRun).toBe(archiveCountAfterFirstRun);
    expect(window.localStorage.getItem("opcode.bar")).toBe("baz");
  });
});
