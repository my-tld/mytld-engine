/**
 * Tiny FIFO semaphore.
 *
 * Bounds how many tasks run at once (e.g. per upstream host) without blocking
 * the event loop. Waiting tasks are released in arrival order.
 */
export class Semaphore {
  private active = 0;

  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.active++;

    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Lazily creates one semaphore per key, e.g. one per RDAP or WHOIS host.
 *
 * @example
 *   const slots = keyedSemaphore(3);
 *   await slots("whois.denic.de").run(() => query(...));
 */
export function keyedSemaphore(max: number) {
  const semaphores = new Map<string, Semaphore>();

  return (key: string): Semaphore => {
    let semaphore = semaphores.get(key);

    if (!semaphore) {
      semaphore = new Semaphore(max);
      semaphores.set(key, semaphore);
    }

    return semaphore;
  };
}
