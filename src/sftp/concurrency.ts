/**
 * Runs `task` over `items` with at most `limit` tasks in flight. The first failure stops new
 * dispatches, waits for in-flight tasks to settle (their errors are swallowed so nothing
 * rejects unhandled), and is rethrown once every worker has drained.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await task(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) {
    throw firstError;
  }
}
