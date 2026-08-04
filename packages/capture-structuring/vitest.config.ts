import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gx-capture/capture-contracts': resolve(
        packageRoot,
        '../capture-contracts/src/index.ts',
      ),
    },
  },
});
