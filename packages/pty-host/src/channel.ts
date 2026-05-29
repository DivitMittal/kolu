/**
 * Minimal multi-subscriber channel used inside `@kolu/pty-host` to fan
 * out PTY data + metadata events to N attached clients. Each subscribe
 * call gets its own AsyncIterable backed by a per-subscriber queue.
 *
 * `publish` is synchronous fire-and-forget — there is no producer-side
 * back-pressure (a PTY's `onData` cannot block), so a subscriber whose
 * consumer has stalled would otherwise buffer without bound. In a
 * long-lived daemon that's a memory leak. We therefore cap each
 * subscriber's queue at `maxQueue` and **drop the slow subscriber** on
 * overflow: its iterator ends and upstream is expected to re-subscribe.
 * For PTY data that re-subscribe pulls a fresh snapshot via
 * `attach`/`getScreenState`, so a dropped delta stream self-heals
 * rather than replaying stale bytes.
 *
 * Subscription is **eager**: `subscribe()` registers the receiver
 * synchronously and starts buffering immediately, *before* the returned
 * iterable is iterated. This is what lets `attach()` close the
 * snapshot/delta race — it subscribes, then serializes the snapshot in
 * the same synchronous tick, so any chunk published in between lands in
 * the buffer rather than being lost in the gap before the consumer's
 * first pull (the daemon's `terminalAttach` source yields the snapshot —
 * suspending the generator — before its `for await` even begins).
 *
 * The package keeps this internal so it doesn't drag a dependency on
 * `@kolu/surface`'s inMemoryChannel through every downstream consumer.
 */

/** Default per-subscriber queue cap before a slow consumer is dropped. */
const DEFAULT_MAX_QUEUE = 10_000;

export interface ChannelOptions {
  /** Per-subscriber buffered-item cap before the subscriber is dropped
   *  to protect the daemon's memory. Defaults to {@link DEFAULT_MAX_QUEUE}. */
  maxQueue?: number;
  /** Invoked when a subscriber is dropped for exceeding `maxQueue`.
   *  Lets the host log which PTY shed a slow consumer. */
  onOverflow?: () => void;
}

export class Channel<T> {
  private readonly subs = new Set<(value: T) => void>();
  private closed = false;
  private readonly maxQueue: number;
  private readonly onOverflow: (() => void) | undefined;

  constructor(options: ChannelOptions = {}) {
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.onOverflow = options.onOverflow;
  }

  publish(value: T): void {
    if (this.closed) return;
    for (const sub of this.subs) sub(value);
  }

  /** Close the channel — all in-flight iterators end gracefully. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subs) sub(CLOSE_SENTINEL as never);
    this.subs.clear();
  }

  subscribe(signal?: AbortSignal): AsyncIterable<T> {
    // Eager registration: the receiver is wired into `subs` NOW, not when
    // the returned iterable is first pulled (see the race note in the
    // file header). An already-closed/aborted channel yields nothing.
    if (this.closed || signal?.aborted) return EMPTY;

    const queue: T[] = [];
    let resolveNext: ((v: IteratorResult<T>) => void) | null = null;
    let done = false;
    const { subs, maxQueue, onOverflow } = this;

    const push = (value: T | typeof CLOSE_SENTINEL): void => {
      if (done) return;
      if (value === CLOSE_SENTINEL) {
        done = true;
        resolveNext?.({ value: undefined, done: true });
        resolveNext = null;
        return;
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: value as T, done: false });
      } else if (queue.length >= maxQueue) {
        // Slow consumer: drop it rather than grow without bound. End the
        // iterator and stop receiving — the queue is freed when the
        // generator is collected. (resolveNext is null here by
        // definition: a queue only grows when no pull is pending.)
        done = true;
        subs.delete(push as (value: T) => void);
        onOverflow?.();
      } else {
        queue.push(value as T);
      }
    };

    subs.add(push as (value: T) => void);
    const onAbort = (): void => {
      done = true;
      subs.delete(push as (value: T) => void);
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    async function* drain(): AsyncIterable<T> {
      try {
        while (!done) {
          if (queue.length > 0) {
            yield queue.shift() as T;
            continue;
          }
          const next = await new Promise<IteratorResult<T>>((resolve) => {
            resolveNext = resolve;
          });
          if (next.done) return;
          yield next.value;
        }
      } finally {
        done = true;
        subs.delete(push as (value: T) => void);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    return drain();
  }
}

const CLOSE_SENTINEL = Symbol("channel-close");

/** Shared empty async-iterable for closed/aborted subscriptions. */
const EMPTY: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ value: undefined, done: true }),
  }),
};
