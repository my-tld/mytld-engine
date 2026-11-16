import type { SafeStore } from "../cache/safe-store.js";

/** How far ahead a request may be scheduled before we give up on that host for now. */
const MAX_QUEUE_DELAY_MS = 4000;

/** Pause added after a 429, so requests already in flight don't hit the limit again. */
const BACKOFF_AFTER_429_MS = 1000;

/** How often a host's cooldown is re-read from the shared store. */
const COOLDOWN_RECHECK_MS = 60_000;

/** Rate recovery per successful request, in requests per second. */
const RATE_RECOVERY_STEP = 0.25;

const MIN_RATE = 1;

const MAX_COOLDOWN_SEC = 86_400;

/** Store key for a host cooldown (also read by my.tld's admin stats). */
export const cooldownKey = (host: string) => `rdap:cool:${host}`;

/**
 * Per-host request pacing for registries.
 *
 * Registry back-ends serve many TLDs from one host (Identity Digital runs hundreds,
 * Google ~40), so limits apply per host, not per TLD:
 *
 * - **Pacing:** requests are spaced 1/rate seconds apart. The rate starts at `maxRate`,
 *   halves on every 429 and recovers slowly on success.
 *
 * - **Bounded waiting:** if the next free slot is too far out, the request is skipped
 *   instead of queued. The caller falls back to WHOIS or reports "unknown".
 *
 * - **Cooldowns:** a long `Retry-After` blocks the host until it expires. Cooldowns are
 *   written to the shared store, so other instances respect them too.
 */
export class HostThrottle {
  private readonly rate = new Map<string, number>();

  private readonly nextSlotAt = new Map<string, number>();

  private readonly cooldownUntil = new Map<string, number>();

  private readonly cooldownCheckedAt = new Map<string, number>();

  constructor(
    private readonly store: SafeStore,
    private readonly maxRate: number,
  ) {}

  /**
   * Reserves the next request slot for `host`.
   *
   * @returns milliseconds to wait before sending, or `null` if the queue is too long.
   */
  reserveSlot(host: string): number | null {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt.get(host) ?? 0);

    if (slot - now > MAX_QUEUE_DELAY_MS) {
      return null;
    }

    this.nextSlotAt.set(host, slot + 1000 / this.currentRate(host));

    return slot - now;
  }

  /** True while the host is in a cooldown: checked locally first, then in the shared store. */
  async isCoolingDown(host: string): Promise<boolean> {
    if (this.isCoolingDownLocally(host)) {
      return true;
    }

    const now = Date.now();
    const checkedAt = this.cooldownCheckedAt.get(host) ?? 0;

    if (checkedAt >= now - COOLDOWN_RECHECK_MS) {
      return false;
    }

    this.cooldownCheckedAt.set(host, now);

    const remainingMs = await this.store.pttl(cooldownKey(host));

    if (remainingMs <= 0) {
      return false;
    }

    this.cooldownUntil.set(host, now + remainingMs);

    return true;
  }

  /** Synchronous check, used right before sending after a wait. */
  isCoolingDownLocally(host: string): boolean {
    return (this.cooldownUntil.get(host) ?? 0) > Date.now();
  }

  /** A request succeeded: let the rate creep back towards the maximum. */
  recordSuccess(host: string): void {
    const rate = this.rate.get(host);

    if (rate === undefined || rate >= this.maxRate) {
      return;
    }

    this.rate.set(host, Math.min(this.maxRate, rate + RATE_RECOVERY_STEP));
  }

  /** A request got HTTP 429: halve the rate and push the queue back. */
  recordRateLimited(host: string): void {
    this.rate.set(host, Math.max(MIN_RATE, this.currentRate(host) / 2));

    const pushedBack = Date.now() + BACKOFF_AFTER_429_MS;
    this.nextSlotAt.set(host, Math.max(this.nextSlotAt.get(host) ?? 0, pushedBack));
  }

  /** Blocks the host for `seconds` (capped at a day), here and for other instances. */
  coolDown(host: string, seconds: number): void {
    const sec = Math.min(seconds, MAX_COOLDOWN_SEC);

    this.cooldownUntil.set(host, Date.now() + sec * 1000);

    void this.store.set(cooldownKey(host), "1", sec);
  }

  private currentRate(host: string): number {
    return this.rate.get(host) ?? this.maxRate;
  }
}
