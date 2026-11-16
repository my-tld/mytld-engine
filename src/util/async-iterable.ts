/**
 * Adapts a "call me back for every item, resolve when done" producer to an async
 * iterator. Items are buffered, so a slow consumer never loses results.
 *
 * Errors from the producer are re-thrown after all buffered items were yielded.
 */
export async function* callbackToAsyncIterable<T>(produce: (push: (item: T) => void) => Promise<void>): AsyncIterable<T> {
  const buffer: T[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: unknown;

  produce((item) => {
    buffer.push(item);
    notify?.();
  })
    .catch((err) => {
      failure = err;
    })
    .finally(() => {
      finished = true;
      notify?.();
    });

  while (true) {
    if (buffer.length) {
      yield buffer.shift()!;
      continue;
    }

    if (finished) {
      break;
    }

    await new Promise<void>((resolve) => (notify = resolve));
    notify = null;
  }

  if (failure) {
    throw failure;
  }
}
