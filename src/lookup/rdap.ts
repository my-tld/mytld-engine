import type { SafeStore } from "../cache/safe-store.js";
import { HostThrottle } from "../throttle/host-throttle.js";
import { keyedSemaphore } from "../throttle/semaphore.js";
import { createBootstrapLoader } from "./rdap-bootstrap.js";

export type RdapAnswer = "available" | "taken" | "unknown";

export interface RdapOptions {
  store: SafeStore;
  fetch: typeof fetch;

  /** Max concurrent requests per RDAP host. */
  perHost: number;

  /** Starting (and maximum) requests per second per host. */
  maxRps: number;

  timeoutMs: number;

  /** TLD → RDAP base URL, checked before the IANA bootstrap. */
  overrides: Record<string, string>;

  bootstrapUrl: string;
  headers: Record<string, string>;
}

/** Registries with working RDAP that are missing from the IANA bootstrap. */
export const DEFAULT_RDAP_OVERRIDES: Record<string, string> = {
  de: "https://rdap.denic.de/",
  ch: "https://rdap.nic.ch/",
  li: "https://rdap.nic.ch/",
};

/** A 429 with a Retry-After longer than this puts the whole host into cooldown. */
const COOLDOWN_THRESHOLD_SEC = 3;

/** Outcome of a single HTTP attempt. "retry" means: briefly rate-limited, try once more. */
type Attempt = RdapAnswer | "retry";

export function createRdap(options: RdapOptions) {
  const bootstrap = createBootstrapLoader({
    store: options.store,
    fetch: options.fetch,
    url: options.bootstrapUrl,
    headers: options.headers,
  });

  const throttle = new HostThrottle(options.store, options.maxRps);
  const hostSlots = keyedSemaphore(options.perHost);

  /** RDAP base URL for a TLD, or null if the registry has no RDAP service. */
  async function baseUrl(tld: string): Promise<string | null> {
    if (options.overrides[tld]) {
      return options.overrides[tld];
    }

    try {
      const byTld = await bootstrap.get();
      return byTld[tld] ?? null;
    } catch {
      return null;
    }
  }

  /** Asks the registry about `domain`. A short rate limit gets exactly one retry. */
  async function check(base: string, domain: string, signal?: AbortSignal): Promise<RdapAnswer> {
    const host = new URL(base).host;
    const url = `${base}domain/${domain}`;

    const first = await attempt(host, url, signal);

    if (first !== "retry") {
      return first;
    }

    const second = await attempt(host, url, signal);

    return second === "retry" ? "unknown" : second;
  }

  async function attempt(host: string, url: string, signal?: AbortSignal): Promise<Attempt> {
    if (await throttle.isCoolingDown(host)) {
      return "unknown";
    }

    const delayMs = throttle.reserveSlot(host);

    if (delayMs === null) {
      return "unknown"; // queue too long: let WHOIS answer instead
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    return hostSlots(host).run(async () => {
      // Re-check: a sibling request may have triggered a cooldown while we waited.
      if (signal?.aborted || throttle.isCoolingDownLocally(host)) {
        return "unknown";
      }

      try {
        const res = await options.fetch(url, {
          headers: { accept: "application/rdap+json", ...options.headers },
          redirect: "follow",
          signal: withTimeout(signal, options.timeoutMs),
        });

        // We only need the status. Releasing the body keeps the socket reusable.
        res.body?.cancel().catch(() => {});

        return interpretResponse(host, res);
      } catch {
        return "unknown";
      }
    });
  }

  function interpretResponse(host: string, res: Response): Attempt {
    if (res.status === 404) {
      throttle.recordSuccess(host);
      return "available";
    }

    if (res.ok) {
      throttle.recordSuccess(host);
      return "taken";
    }

    if (res.status === 429) {
      throttle.recordRateLimited(host);

      const retryAfterSec = Number(res.headers.get("retry-after"));

      if (retryAfterSec > COOLDOWN_THRESHOLD_SEC) {
        throttle.coolDown(host, retryAfterSec);
        return "unknown";
      }

      return "retry";
    }

    return "unknown"; // 400 (query not supported), 5xx
  }

  async function warmup(): Promise<void> {
    await bootstrap.get();
  }

  return { baseUrl, check, warmup };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);

  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
