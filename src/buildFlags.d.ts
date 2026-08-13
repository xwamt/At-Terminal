/**
 * Build-time variant flag, supplied by esbuild's `define` (and by vitest's, for tests).
 *
 * It is deliberately a global rather than `export const MCP_ENABLED` from a module.
 * esbuild only eliminates a branch whose condition is a literal at the use site: routed
 * through any binding — cross-module *or* same-file — `if (MCP_ENABLED)` survives, and
 * the base variant ends up shipping the entire MCP bridge, publisher and installer it is
 * built to exclude. Read it directly at the branch and nowhere else.
 */
declare const MCP_ENABLED: boolean;
