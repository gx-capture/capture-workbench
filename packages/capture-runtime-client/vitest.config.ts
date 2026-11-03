import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every spec in the package runs; the test target passes no file filter.
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
  },
});
