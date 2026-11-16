import type { DomainResult, DomainStatus } from "../core/domain.js";
import type { SafeStore } from "./safe-store.js";
import { memoryStore } from "./store.js";

/** What we persist per domain. Only definitive answers are ever stored. */
interface CachedAnswer {
  status: DomainStatus;
  verified: true;
}

export interface ResultTtl {
  taken: number;
  available: number;
}

const KEY_PREFIX = "dom:v2:";

/** L1 entries live at most this long, so instances pick up shared-store changes. */
const L1_MAX_TTL_SEC = 600;

/** L1 lifetime for values pulled up from the shared store. */
const L1_PROMOTED_TTL_SEC = 60;

const L1_MAX_ENTRIES = 50_000;

/**
 * Two-level cache for lookup results: an in-process L1 in front of the shared store,
 * so hot names don't need a store round-trip at all.
 */
export class ResultCache {
  private readonly l1 = memoryStore({ maxEntries: L1_MAX_ENTRIES });

  constructor(
    private readonly store: SafeStore,
    private readonly ttl: ResultTtl,
  ) {}

  /** Looks up many domains at once: L1 first, then a single `mget()` for the rest. */
  async getMany(domains: string[]): Promise<Map<string, CachedAnswer>> {
    const found = new Map<string, CachedAnswer>();
    const misses: string[] = [];

    const l1Values = await this.l1.mget(domains);

    domains.forEach((domain, i) => {
      const raw = l1Values[i];

      if (raw) {
        found.set(domain, JSON.parse(raw) as CachedAnswer);
      } else {
        misses.push(domain);
      }
    });

    if (!misses.length) {
      return found;
    }

    const storeValues = await this.store.mget(misses.map((domain) => KEY_PREFIX + domain));

    storeValues.forEach((raw, i) => {
      const answer = raw ? tryParse(raw) : null;

      if (!answer) {
        return;
      }

      found.set(misses[i], answer);
      void this.l1.set(misses[i], raw!, L1_PROMOTED_TTL_SEC);
    });

    return found;
  }

  /** Stores a result if it's definitive. Writes to the shared store are batched per tick. */
  remember(result: DomainResult): void {
    if (result.status === "unknown" || !result.verified) {
      return;
    }

    const ttl = result.status === "taken" ? this.ttl.taken : this.ttl.available;
    const raw = JSON.stringify({ status: result.status, verified: true } satisfies CachedAnswer);

    void this.l1.set(result.domain, raw, Math.min(ttl, L1_MAX_TTL_SEC));
    this.store.queue(KEY_PREFIX + result.domain, raw, ttl);
  }
}

function tryParse(raw: string): CachedAnswer | null {
  try {
    return JSON.parse(raw) as CachedAnswer;
  } catch {
    return null;
  }
}
