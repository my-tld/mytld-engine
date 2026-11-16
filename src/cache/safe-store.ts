import type { CacheStore } from "./store.js";

type Entry = { key: string; value: string; ttlSec: number };

/**
 * Wraps a user-supplied store so that:
 *
 * - nothing it does can throw into a lookup (errors become cache misses or no-ops),
 * - every key gets the configured prefix,
 * - fire-and-forget writes are coalesced into one `setMany()` per tick.
 */
export function safeStore(store: CacheStore, prefix: string) {
  const prefixed = (key: string) => prefix + key;

  const pendingWrites: Entry[] = [];
  let flushScheduled = false;

  function flush() {
    flushScheduled = false;

    const batch = pendingWrites.splice(0);

    if (!batch.length) {
      return;
    }

    const write = store.setMany
      ? store.setMany(batch)
      : Promise.all(batch.map((entry) => store.set(entry.key, entry.value, entry.ttlSec)));

    Promise.resolve(write).catch(() => {});
  }

  async function get(key: string): Promise<string | null> {
    try {
      return await store.get(prefixed(key));
    } catch {
      return null;
    }
  }

  async function set(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await store.set(prefixed(key), value, ttlSec);
    } catch {
      // best effort
    }
  }

  async function mget(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) {
      return [];
    }

    try {
      return await store.mget(keys.map(prefixed));
    } catch {
      return keys.map(() => null);
    }
  }

  async function pttl(key: string): Promise<number> {
    try {
      return await store.pttl(prefixed(key));
    } catch {
      return -2;
    }
  }

  /** Buffered write, flushed on the next macrotask together with its siblings. */
  function queue(key: string, value: string, ttlSec: number): void {
    pendingWrites.push({ key: prefixed(key), value, ttlSec });

    if (flushScheduled) {
      return;
    }

    flushScheduled = true;
    setTimeout(flush, 0);
  }

  /** Read-through JSON cache: returns the stored value, or loads, stores and returns it. */
  async function json<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const hit = await get(key);

    if (hit) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        // corrupt entry: reload below
      }
    }

    const value = await load();
    void set(key, JSON.stringify(value), ttlSec);

    return value;
  }

  return { get, set, mget, pttl, queue, json };
}

export type SafeStore = ReturnType<typeof safeStore>;
