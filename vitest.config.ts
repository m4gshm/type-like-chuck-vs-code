import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/unit/vscode-stub.ts'),
    },
  },
  test: {
    include: ['src/test/unit/**/*.test.ts'],
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout', 'performance'],
    },
  },
});
