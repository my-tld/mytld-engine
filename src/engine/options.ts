import type { CacheStore } from "../cache/store.js";
import type { DomainResult } from "../core/domain.js";

export interface EngineOptions {
  /** Shared cache (results, IANA bootstrap, WHOIS servers, registry cooldowns). Default: in-memory. */
  store?: CacheStore;

  /** Prefix for every store key. Default: "". */
  keyPrefix?: string;

  /** Upstream DNS resolvers (IPs). Default: Cloudflare + Google. A local Unbound is ideal in production. */
  dnsServers?: string[];

  /** Max in-flight DNS queries. Default 256. */
  dnsConcurrency?: number;

  /** Per-query DNS timeout. Default 1200 ms. */
  dnsTimeoutMs?: number;

  /** Max concurrent requests per RDAP host. Default 6. */
  rdapPerHost?: number;

  /** Starting (and maximum) requests per second per RDAP host. Adapts down on 429. Default 8. */
  rdapRps?: number;

  /** RDAP request timeout. Default 4000 ms. */
  rdapTimeoutMs?: number;

  /** Extra / replacement RDAP base URLs by TLD (merged over the built-in overrides). */
  rdapOverrides?: Record<string, string>;

  /** Max concurrent connections per WHOIS server. Default 3. */
  whoisPerHost?: number;

  /** WHOIS socket timeout. Default 4000 ms. */
  whoisTimeoutMs?: number;

  /** Extra / replacement WHOIS servers by TLD (merged over the built-ins). */
  whoisServers?: Record<string, string>;

  /** Cache lifetimes in seconds for verified answers. */
  ttl?: { taken?: number; available?: number };

  /** Custom fetch (proxies, instrumentation). Default: global fetch. */
  fetch?: typeof fetch;

  /** Sent with HTTP requests to registries. */
  userAgent?: string;
}

export interface CheckOptions {
  signal?: AbortSignal;
}

export interface Engine {
  /** Checks one domain and resolves with the final answer. */
  check(domain: string, opts?: CheckOptions): Promise<DomainResult>;

  /** Checks many domains concurrently; `onResult` fires as each answer is known. */
  checkMany(domains: string[], onResult: (result: DomainResult) => void, opts?: CheckOptions): Promise<void>;

  /** Same as checkMany, as an async iterator (results in completion order). */
  stream(domains: string[], opts?: CheckOptions): AsyncIterable<DomainResult>;

  /** Pre-loads the IANA RDAP bootstrap so the first lookup doesn't pay for it. */
  warmup(): Promise<void>;

  /** RDAP base URL for a TLD, or null if the registry has none. */
  rdapBase(tld: string): Promise<string | null>;
}

export const DEFAULTS = {
  dnsServers: ["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"],
  dnsConcurrency: 256,
  dnsTimeoutMs: 1200,

  rdapPerHost: 6,
  rdapRps: 8,
  rdapTimeoutMs: 4000,
  bootstrapUrl: "https://data.iana.org/rdap/dns.json",

  whoisPerHost: 3,
  whoisTimeoutMs: 4000,

  ttlTaken: 6 * 3600,
  ttlAvailable: 600,
} as const;
