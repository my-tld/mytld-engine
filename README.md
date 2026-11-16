# @mytld/engine

Fast, honest domain availability checks for Node.js. This is the engine behind [my.tld](https://mytld.dev).

- **Fast:** hundreds of parallel DNS queries via c-ares. They don't go through libuv's 4-thread pool, so nothing waits in line. Taken names come back in ~20 ms.
- **Honest:** a missing DNS record does **not** mean a domain is free. Registered names can be on hold, parked or reserved. A name is only reported `available` after the registry confirms it via RDAP or WHOIS.
- **Polite:** concurrency limits per registry, pacing that slows down on HTTP 429, and `Retry-After` cooldowns that can be shared across instances.
- **Pluggable cache:** in-memory by default, Redis adapter included, or bring your own.
- **640 curated TLDs:** the lists are validated against the IANA root zone.

```sh
npm install @mytld/engine
```

Node.js ≥ 20.3. ESM only.

## Usage

```ts
import { createEngine, TOP_TLDS } from "@mytld/engine";

const engine = createEngine();

// one domain
await engine.check("example.com");
// → { domain: "example.com", status: "taken", verified: true, source: "dns" }

// many domains, results as they arrive
for await (const r of engine.stream(TOP_TLDS.map((t) => `myidea.${t}`))) {
  console.log(r.domain, r.status);
}

// or with a callback (e.g. to write Server-Sent Events)
await engine.checkMany(domains, (r) => res.write(`data: ${JSON.stringify(r)}\n\n`), { signal });
```

### Results

```ts
interface DomainResult {
  domain: string;
  status: "available" | "taken" | "unknown";
  verified: boolean; // true = definitive (NS delegation or a registry answer)
  source: "cache" | "dns" | "rdap" | "whois";
  noDns?: boolean; // on "unknown": no DNS record, but no registry confirmed it either
}
```

`unknown` with `noDns: true` means the name is *possibly* free. Show it as "unverified", never as available.

### How a lookup works

1. **Cache:** an in-process L1 cache, then one `mget` on your store for the whole batch.
2. **DNS NS query:** NS records present means **taken**, and that answer is final.
3. **RDAP:** from the IANA bootstrap, plus overrides for registries missing from it (`.de`, `.ch`, `.li`). A 404 means available, a 200 means taken.
4. **WHOIS:** fallback on port 43. Servers are discovered via `whois.iana.org`. The engine only reports *taken* when it finds positive evidence in the reply.

### Shared cache with Redis

```ts
import Redis from "ioredis";
import { createEngine, redisStore } from "@mytld/engine";

const redis = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
const engine = createEngine({ store: redisStore(redis) });
```

If Redis is down, cache reads count as misses and writes are dropped. Lookups never wait on the cache.

Implement `CacheStore` (`get`, `mget`, `set`, `pttl`, optional `setMany`) to use anything else.

### Options

| option | default | |
|---|---|---|
| `store` | `memoryStore()` | results, IANA bootstrap, WHOIS servers, registry cooldowns |
| `keyPrefix` | `""` | prefix for all store keys |
| `dnsServers` | Cloudflare + Google | a local Unbound is ideal in production |
| `dnsConcurrency` | `256` | max in-flight DNS queries |
| `dnsTimeoutMs` | `1200` | |
| `rdapPerHost` | `6` | concurrent requests per RDAP host |
| `rdapRps` | `8` | starting/max requests per second per host, halves on 429 |
| `rdapTimeoutMs` | `4000` | |
| `rdapOverrides` | `.de`, `.ch`, `.li` | `{ tld: baseUrl }` |
| `whoisPerHost` | `3` | |
| `whoisTimeoutMs` | `4000` | |
| `whoisServers` | a few ccTLDs | `{ tld: host }`; others are auto-discovered |
| `ttl` | `{ taken: 21600, available: 600 }` | seconds; only verified answers are cached |
| `fetch` | `globalThis.fetch` | |
| `userAgent` | none | sent to registries |

### Browser-safe helpers

The main entry uses `node:dns` and `node:net`. Parsing and TLD lists have their own entry points that are safe to import in client code:

```ts
import { parseQuery, isValidDomain, tldOf } from "@mytld/engine/domain";
import { TOP_TLDS, EXTENDED_TLDS, ALL_TLDS } from "@mytld/engine/tlds";

parseQuery("https://www.Müller.dev/x"); // → { name: "xn--mller-kva", tld: "dev" }
```

## Good citizenship

Registries rate-limit, and some block an IP for a full day if you burst them. Keep the defaults unless you know a registry's limits. Cache aggressively, and don't run bulk scans.

## Development

```sh
pnpm install
pnpm test      # unit tests (offline)
pnpm smoke     # live check of the top 25 TLDs against real registries
```

## License

MIT
