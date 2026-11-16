import net from "node:net";
import type { SafeStore } from "../cache/safe-store.js";
import { keyedSemaphore } from "../throttle/semaphore.js";
import { formatQuery, parseWhois, type WhoisAnswer } from "./whois-parser.js";

export type { WhoisAnswer } from "./whois-parser.js";

export interface WhoisOptions {
  store: SafeStore;

  /** Max concurrent connections per WHOIS server. */
  perHost: number;

  timeoutMs: number;

  /** TLD → WHOIS server, checked before discovery via whois.iana.org. */
  servers: Record<string, string>;
}

/** Well-known servers. Everything else is discovered via whois.iana.org. */
export const DEFAULT_WHOIS_SERVERS: Record<string, string> = {
  de: "whois.denic.de",
  eu: "whois.eu",
  at: "whois.nic.at",
  io: "whois.nic.io",
  sh: "whois.nic.sh",
  co: "whois.registry.co",
  me: "whois.nic.me",
};

const IANA_WHOIS = "whois.iana.org";

const SERVER_CACHE_TTL_SEC = 7 * 86_400;

const MAX_RESPONSE_BYTES = 64 * 1024;

export function createWhois(options: WhoisOptions) {
  const serverLookups = new Map<string, Promise<string | null>>();

  // WHOIS servers are much stricter than RDAP, so concurrency stays low.
  const hostSlots = keyedSemaphore(options.perHost);

  /** Sends one query over TCP port 43. Resolves with whatever arrived before close or timeout. */
  function query(host: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;

      const collected = () => Buffer.concat(chunks).toString("utf8");

      const socket = net.connect({ host, port: 43 });
      socket.setTimeout(options.timeoutMs);

      socket.on("connect", () => {
        socket.write(`${text}\r\n`);
      });

      socket.on("data", (chunk) => {
        chunks.push(chunk);
        received += chunk.length;

        if (received > MAX_RESPONSE_BYTES) {
          socket.destroy();
        }
      });

      socket.on("timeout", () => {
        socket.destroy(new Error("timeout"));
      });

      // A reset after a complete answer is common, so keep partial data if there is any.
      socket.on("error", (err) => {
        if (received) resolve(collected());
        else reject(err);
      });

      socket.on("close", () => {
        resolve(collected());
      });
    });
  }

  /** WHOIS server for a TLD: built-in table, else discovered via IANA (cached for a week). */
  function serverFor(tld: string): Promise<string | null> {
    if (options.servers[tld]) {
      return Promise.resolve(options.servers[tld]);
    }

    const known = serverLookups.get(tld);

    if (known) {
      return known;
    }

    const lookup = options.store
      .json(`whois:server:v1:${tld}`, SERVER_CACHE_TTL_SEC, () => discoverServer(tld))
      .catch(() => null);

    serverLookups.set(tld, lookup);

    return lookup;
  }

  async function discoverServer(tld: string): Promise<string | null> {
    const reply = await query(IANA_WHOIS, tld);

    return reply.match(/^whois:\s*(\S+)/im)?.[1]?.toLowerCase() ?? null;
  }

  async function check(tld: string, domain: string): Promise<WhoisAnswer> {
    const host = await serverFor(tld);

    if (!host) {
      return "unknown";
    }

    return hostSlots(host).run(async () => {
      try {
        const reply = await query(host, formatQuery(tld, domain));
        return parseWhois(reply);
      } catch {
        return "unknown";
      }
    });
  }

  return { check, serverFor };
}
