import { Resolver } from "node:dns/promises";
import { Semaphore } from "../throttle/semaphore.js";

/**
 * - `registered`: the TLD zone delegates the name (NS records exist). Final answer: taken.
 * - `nxdomain`:   no such name in DNS. This does NOT mean free (see create-engine.ts).
 * - `unknown`:    no usable answer (timeout, SERVFAIL, NODATA).
 */
export type DnsSignal = "registered" | "nxdomain" | "unknown";

export interface DnsOptions {
  servers: string[];
  concurrency: number;
  timeoutMs: number;
}

type QueryResult = DnsSignal | "transient-error";

/** Errors that say "this resolver didn't answer", not "the name doesn't exist". */
const TRANSIENT_ERRORS = new Set(["ETIMEOUT", "ECONNREFUSED", "ESERVFAIL"]);

/**
 * Creates an NS-record checker.
 *
 * Uses `dns.promises.Resolver` (c-ares) instead of `dns.lookup()`. lookup() runs
 * getaddrinfo on libuv's threadpool (4 threads by default), so hundreds of queries
 * would wait in line. c-ares sends them all concurrently from the event loop.
 *
 * Queries are spread round-robin across the configured resolvers.
 */
export function createDns({ servers, concurrency, timeoutMs }: DnsOptions) {
  if (!servers.length) {
    throw new Error("@mytld/engine: at least one DNS server is required");
  }

  const resolvers = servers.map((server) => {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([server]);
    return resolver;
  });

  const gate = new Semaphore(concurrency);
  let nextResolver = 0;

  return function checkNs(domain: string): Promise<DnsSignal> {
    return gate.run(async () => {
      const index = nextResolver++;
      const first = await queryNs(resolvers[index % resolvers.length], domain);

      if (first !== "transient-error" || resolvers.length === 1) {
        return orUnknown(first);
      }

      // Public resolvers occasionally drop bursts: retry once on a different upstream.
      const second = await queryNs(resolvers[(index + 1) % resolvers.length], domain);

      return orUnknown(second);
    });
  };
}

async function queryNs(resolver: Resolver, domain: string): Promise<QueryResult> {
  try {
    const records = await resolver.resolveNs(domain);

    return records.length ? "registered" : "unknown";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";

    if (code === "ENOTFOUND") {
      return "nxdomain";
    }

    if (TRANSIENT_ERRORS.has(code)) {
      return "transient-error";
    }

    // e.g. ENODATA: the name exists without NS records. Let the registry decide.
    return "unknown";
  }
}

function orUnknown(result: QueryResult): DnsSignal {
  return result === "transient-error" ? "unknown" : result;
}
