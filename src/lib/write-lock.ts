/**
 * Process-wide write channel.
 *
 * All vault/config mutations should run through `withWriteLock` so only one
 * write runs at a time (no parallel read-modify-write after `await` in handlers).
 */
let tail: Promise<void> = Promise.resolve();

/** Run `fn` exclusively on the write channel (FIFO). */
export function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  // Keep the chain alive after both success and failure.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
