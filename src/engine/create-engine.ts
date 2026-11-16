import { ResultCache } from "../cache/result-cache.js";
import { safeStore } from "../cache/safe-store.js";
import { memoryStore } from "../cache/store.js";
import { type DomainResult, isValidDomain, type LookupSource, tldOf } from "../core/domain.js";
import { createDns } from "../lookup/dns.js";
import { createRdap, DEFAULT_RDAP_OVERRIDES } from "../lookup/rdap.js";
import { createWhois, DEFAULT_WHOIS_SERVERS } from "../lookup/whois.js";
import { callbackToAsyncIterable } from "../util/async-iterable.js";
import { type CheckOptions, DEFAULTS, type Engine, type EngineOptions } from "./options.js";

/** A registry's answer: from RDAP if it had one, else from WHOIS. */
interface RegistryVerdict {
  status: "available" | "taken" | "unknown";
  source: LookupSource;
}

/**
 * Creates a lookup engine. Every engine owns its own resolvers, throttles and caches,
 * so create one per process and reuse it.
 *
 * Pipeline per domain (all domains run concurrently):
 *
 *  1. **Cache:** in-process L1, then one `mget()` on the store for the whole batch.
 *  2. **DNS:** an NS query (~10–40 ms). If the name is delegated, it's **taken**. Done.
 *  3. **Registry:** RDAP (IANA bootstrap + overrides), WHOIS as fallback.
 *
 * Step 3 runs for every name without a delegation, because a missing DNS record doesn't
 * mean free: on-hold, parked and reserved names have none. So "available" is only ever
 * reported after a registry confirmed it. Without a registry answer the result is
 * "unknown", with `noDns: true` when DNS had nothing either.
 */
export function createEngine(options: EngineOptions = {}): Engine {
  /* ── building blocks ── */

  const store = safeStore(options.store ?? memoryStore(), options.keyPrefix ?? "");

  const cache = new ResultCache(store, {
    taken: options.ttl?.taken ?? DEFAULTS.ttlTaken,
    available: options.ttl?.available ?? DEFAULTS.ttlAvailable,
  });

  const checkNs = createDns({
    servers: options.dnsServers ?? [...DEFAULTS.dnsServers],
    concurrency: options.dnsConcurrency ?? DEFAULTS.dnsConcurrency,
    timeoutMs: options.dnsTimeoutMs ?? DEFAULTS.dnsTimeoutMs,
  });

  const rdap = createRdap({
    store,
    fetch: options.fetch ?? globalThis.fetch,
    perHost: options.rdapPerHost ?? DEFAULTS.rdapPerHost,
    maxRps: options.rdapRps ?? DEFAULTS.rdapRps,
    timeoutMs: options.rdapTimeoutMs ?? DEFAULTS.rdapTimeoutMs,
    overrides: { ...DEFAULT_RDAP_OVERRIDES, ...options.rdapOverrides },
    bootstrapUrl: DEFAULTS.bootstrapUrl,
    headers: options.userAgent ? { "user-agent": options.userAgent } : {},
  });

  const whois = createWhois({
    store,
    perHost: options.whoisPerHost ?? DEFAULTS.whoisPerHost,
    timeoutMs: options.whoisTimeoutMs ?? DEFAULTS.whoisTimeoutMs,
    servers: { ...DEFAULT_WHOIS_SERVERS, ...options.whoisServers },
  });

  /* ── registry check, shared between concurrent callers for the same domain ── */

  const pendingVerdicts = new Map<string, Promise<RegistryVerdict>>();

  async function askRegistry(domain: string, signal?: AbortSignal): Promise<RegistryVerdict> {
    const tld = tldOf(domain);
    const base = await rdap.baseUrl(tld);

    if (base) {
      const answer = await rdap.check(base, domain, signal);

      if (answer !== "unknown") {
        return { status: answer, source: "rdap" };
      }
    }

    if (signal?.aborted) {
      return { status: "unknown", source: "rdap" };
    }

    return { status: await whois.check(tld, domain), source: "whois" };
  }

  function askRegistryOnce(domain: string, signal?: AbortSignal): Promise<RegistryVerdict> {
    const pending = pendingVerdicts.get(domain);

    if (pending) {
      return pending;
    }

    const verdict = askRegistry(domain, signal).finally(() => pendingVerdicts.delete(domain));
    pendingVerdicts.set(domain, verdict);

    return verdict;
  }

  /* ── one uncached lookup: DNS, then the registry ── */

  async function lookup(domain: string, signal?: AbortSignal): Promise<DomainResult | null> {
    const dns = await checkNs(domain);

    if (signal?.aborted) {
      return null;
    }

    if (dns === "registered") {
      return { domain, status: "taken", verified: true, source: "dns" };
    }

    const verdict = await askRegistryOnce(domain, signal);

    if (signal?.aborted) {
      return null;
    }

    if (verdict.status !== "unknown") {
      return { domain, status: verdict.status, verified: true, source: verdict.source };
    }

    return { domain, status: "unknown", verified: false, source: verdict.source, noDns: dns === "nxdomain" };
  }

  /* ── public API ── */

  async function checkMany(domains: string[], onResult: (result: DomainResult) => void, { signal }: CheckOptions = {}) {
    const unique = normalize(domains);
    const cached = await cache.getMany(unique);
    const lookups: Promise<void>[] = [];

    for (const domain of unique) {
      const hit = cached.get(domain);

      if (hit) {
        onResult({ domain, status: hit.status, verified: true, source: "cache" });
        continue;
      }

      const work = lookup(domain, signal)
        .then((result) => {
          if (!result || signal?.aborted) {
            return;
          }

          cache.remember(result);
          onResult(result);
        })
        .catch(() => {}); // a single failed lookup must not reject the batch

      lookups.push(work);
    }

    await Promise.all(lookups);
  }

  async function check(domain: string, opts: CheckOptions = {}): Promise<DomainResult> {
    let result: DomainResult | undefined;

    await checkMany([domain], (r) => (result = r), opts);

    if (!result) {
      throw new Error(opts.signal?.aborted ? "aborted" : "lookup failed");
    }

    return result;
  }

  function stream(domains: string[], opts: CheckOptions = {}): AsyncIterable<DomainResult> {
    return callbackToAsyncIterable<DomainResult>((push) => checkMany(domains, push, opts));
  }

  return {
    check,
    checkMany,
    stream,
    warmup: rdap.warmup,
    rdapBase: rdap.baseUrl,
  };
}

/** Lower-cases, trims and de-duplicates; rejects anything that isn't "label.tld". */
function normalize(domains: string[]): string[] {
  const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()))];
  const invalid = unique.filter((d) => !isValidDomain(d));

  if (invalid.length) {
    throw new TypeError(`@mytld/engine: invalid domain(s): ${invalid.slice(0, 5).join(", ")}`);
  }

  return unique;
}
