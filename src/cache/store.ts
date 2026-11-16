/**
 * Pluggable key/value store for results, the IANA bootstrap, WHOIS server discovery
 * and rate-limit cooldowns.
 *
 * Implementations should not throw. The engine wraps every call anyway (see
 * `safe-store.ts`), because a cache must never be able to break a lookup.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;

  mget(keys: string[]): Promise<(string | null)[]>;

  set(key: string, value: string, ttlSec: number): Promise<void>;

  /** Optional batched write, e.g. one Redis pipeline per tick. */
  setMany?(entries: { key: string; value: string; ttlSec: number }[]): Promise<void>;

  /** Remaining lifetime in milliseconds; <= 0 when the key doesn't exist. */
  pttl(key: string): Promise<number>;
}

/* ───────────────────────────── memory ───────────────────────────── */

/** In-process store with TTLs and a size cap. When full, the oldest ~10% are evicted. */
export function memoryStore({ maxEntries = 50_000 } = {}): CacheStore {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function read(key: string) {
    const entry = entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt < Date.now()) {
      entries.delete(key);
      return undefined;
    }

    return entry;
  }

  function write(key: string, value: string, ttlSec: number) {
    if (entries.size >= maxEntries) {
      evictOldest(Math.ceil(maxEntries / 10));
    }

    entries.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  /** Map iterates in insertion order, so the first keys are the oldest. */
  function evictOldest(count: number) {
    for (const key of entries.keys()) {
      entries.delete(key);

      if (--count <= 0) {
        break;
      }
    }
  }

  return {
    async get(key) {
      return read(key)?.value ?? null;
    },

    async mget(keys) {
      return keys.map((key) => read(key)?.value ?? null);
    },

    async set(key, value, ttlSec) {
      write(key, value, ttlSec);
    },

    async setMany(batch) {
      for (const entry of batch) {
        write(entry.key, entry.value, entry.ttlSec);
      }
    },

    async pttl(key) {
      const entry = read(key);
      return entry ? entry.expiresAt - Date.now() : -2;
    },
  };
}

/* ───────────────────────────── redis ───────────────────────────── */

/** The subset of an ioredis-compatible client the adapter needs. */
export interface RedisLike {
  get(key: string): Promise<string | null>;

  mget(...keys: string[]): Promise<(string | null)[]>;

  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;

  pttl(key: string): Promise<number>;

  pipeline?(): {
    set(key: string, value: string, mode: "EX", seconds: number): unknown;
    exec(): Promise<unknown>;
  };

  status?: string;
}

/**
 * Redis adapter for ioredis. Shares results and registry cooldowns across instances.
 *
 * If the client isn't connected (`status !== "ready"`), calls resolve as cache misses
 * instead of waiting. Lookups must never block on the cache.
 */
export function redisStore(client: RedisLike): CacheStore {
  const isReady = () => client.status === undefined || client.status === "ready";

  return {
    async get(key) {
      if (!isReady()) {
        return null;
      }

      return client.get(key).catch(() => null);
    },

    async mget(keys) {
      if (!keys.length || !isReady()) {
        return keys.map(() => null);
      }

      return client.mget(...keys).catch(() => keys.map(() => null));
    },

    async set(key, value, ttlSec) {
      if (!isReady()) {
        return;
      }

      await client.set(key, value, "EX", ttlSec).catch(() => {});
    },

    async setMany(batch) {
      if (!batch.length || !isReady()) {
        return;
      }

      if (client.pipeline) {
        const pipeline = client.pipeline();

        for (const entry of batch) {
          pipeline.set(entry.key, entry.value, "EX", entry.ttlSec);
        }

        await pipeline.exec().catch(() => {});
        return;
      }

      await Promise.all(batch.map((entry) => client.set(entry.key, entry.value, "EX", entry.ttlSec).catch(() => {})));
    },

    async pttl(key) {
      if (!isReady()) {
        return -2;
      }

      return client.pttl(key).catch(() => -2);
    },
  };
}
