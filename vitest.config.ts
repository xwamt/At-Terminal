import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors esbuild's define (see src/buildFlags.d.ts). Tests cover the MCP build.
  define: {
    MCP_ENABLED: 'true'
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts']
  },
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), 'test-fixtures/vscode.ts')
    }
  }
});
