/**
 * ssh2 initializes crypto bindings and parses cipher tables when its module body runs,
 * which costs tens of milliseconds. Loading it here on the first connect instead of at
 * activation keeps that cost off the extension's startup path. esbuild marks ssh2 as
 * external, so the dynamic import compiles to a plain lazy `require('ssh2')` in the
 * CJS bundle; the resolved module is cached so every later connect is synchronous-fast.
 */
export type Ssh2Module = typeof import('ssh2');

let cached: Promise<Ssh2Module> | undefined;

export function getSsh2(): Promise<Ssh2Module> {
  cached ??= import('ssh2');
  return cached;
}

// Vitest resolves a mocked dynamic import on a macrotask, so a first-connect load never
// finishes inside the microtask-only flushes several suites use around fake timers.
// Warming the cache at module load keeps those tests deterministic; module load sits
// well before any test body, so the promise is settled by the time a test needs it.
// Production skips this branch and stays lazy.
if (process.env.VITEST) {
  void getSsh2();
}
