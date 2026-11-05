import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,mts}'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
      '@watch-party': fileURLToPath(new URL('../../src/features/watch-party', import.meta.url)),
    },
  },
});
