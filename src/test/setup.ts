import { afterEach, beforeEach } from 'vitest';
import { clearWorkspaceDiagnostics } from '@/services/workspaceDiagnostics';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

const localStorageIsUsable =
  typeof globalThis.localStorage !== 'undefined' &&
  typeof globalThis.localStorage.getItem === 'function' &&
  typeof globalThis.localStorage.setItem === 'function' &&
  typeof globalThis.localStorage.removeItem === 'function';

if (!localStorageIsUsable) {
  const memoryStorage = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });
  }
}

function clearWorkspaceStorage() {
  const storage = globalThis.localStorage as Storage | undefined;
  if (!storage) {
    return;
  }

  if (typeof storage.clear === 'function') {
    storage.clear();
    return;
  }

  const keys: string[] = [];
  const length = Number(storage.length ?? 0);
  for (let index = 0; index < length; index += 1) {
    const key = storage.key(index);
    if (key) {
      keys.push(key);
    }
  }

  keys.forEach((key) => {
    if (typeof storage.removeItem === 'function') {
      storage.removeItem(key);
    }
  });
}

beforeEach(() => {
  clearWorkspaceStorage();
  clearWorkspaceDiagnostics();
});

afterEach(() => {
  clearWorkspaceStorage();
  clearWorkspaceDiagnostics();
});
