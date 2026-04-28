import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
