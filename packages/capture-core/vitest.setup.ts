// happy-dom's localStorage/sessionStorage in vitest occasionally ship without
// working setItem/getItem/clear. storage-snapshot.test.ts relies on them, so
// mirror the extension's defensive polyfill: swap in an in-memory Storage when
// the real methods are missing.
const ensureStorageWorks = (storage: Storage | undefined): Storage => {
  if (
    storage &&
    typeof storage.setItem === 'function' &&
    typeof storage.getItem === 'function' &&
    typeof storage.removeItem === 'function' &&
    typeof storage.clear === 'function'
  ) {
    return storage;
  }
  const state = new Map<string, string>();
  return {
    get length() {
      return state.size;
    },
    clear() {
      state.clear();
    },
    getItem(key: string): string | null {
      return state.has(key) ? (state.get(key) ?? null) : null;
    },
    key(index: number): string | null {
      return Array.from(state.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      state.delete(key);
    },
    setItem(key: string, value: string): void {
      state.set(key, String(value));
    },
  };
};

if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, 'localStorage', {
      value: ensureStorageWorks(window.localStorage),
      configurable: true,
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: ensureStorageWorks(window.sessionStorage),
      configurable: true,
    });
  } catch {
    // node env without window — ignore
  }
}
