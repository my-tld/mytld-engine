import type { SafeStore } from "../cache/safe-store.js";

/** TLD → RDAP base URL, always with a trailing slash. */
export type Bootstrap = Record<string, string>;

const CACHE_KEY = "rdap:bootstrap:v1";

const TTL_SEC = 24 * 3600;

const FETCH_TIMEOUT_MS = 5000;

interface IanaBootstrapFile {
  services: [tlds: string[], urls: string[]][];
}

export interface BootstrapLoaderOptions {
  store: SafeStore;
  fetch: typeof fetch;
  url: string;
  headers: Record<string, string>;
}

/**
 * Loads the IANA RDAP bootstrap (dns.json) at most once per day, through the shared store.
 *
 * Concurrent callers share one in-flight request. While a stale copy is being
 * refreshed, the stale copy keeps being served.
 */
export function createBootstrapLoader({ store, fetch, url, headers }: BootstrapLoaderOptions) {
  let cached: Bootstrap | null = null;
  let loadedAt = 0;
  let inflight: Promise<Bootstrap> | null = null;

  async function fetchFromIana(): Promise<Bootstrap> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers });

    if (!res.ok) {
      throw new Error(`IANA bootstrap ${res.status}`);
    }

    const file = (await res.json()) as IanaBootstrapFile;

    return indexByTld(file);
  }

  function isFresh(): boolean {
    return cached !== null && Date.now() - loadedAt < TTL_SEC * 1000;
  }

  function get(): Promise<Bootstrap> {
    if (isFresh()) {
      return Promise.resolve(cached!);
    }

    inflight ??= store
      .json(CACHE_KEY, TTL_SEC, fetchFromIana)
      .then((loaded) => {
        cached = loaded;
        loadedAt = Date.now();
        return loaded;
      })
      .finally(() => {
        inflight = null;
      });

    return cached ? Promise.resolve(cached) : inflight;
  }

  return { get };
}

function indexByTld(file: IanaBootstrapFile): Bootstrap {
  const byTld: Bootstrap = {};

  for (const [tlds, urls] of file.services) {
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];

    if (!url) {
      continue;
    }

    const base = url.endsWith("/") ? url : `${url}/`;

    for (const tld of tlds) {
      byTld[tld.toLowerCase()] = base;
    }
  }

  return byTld;
}
