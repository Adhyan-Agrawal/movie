import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const TEST_SECRET = 'test-watch-party-secret-that-is-at-least-32-bytes';

export default defineConfig({
  envDir: false,
  plugins: [
    cloudflareTest({
      // Keep runtime tests local without loading .dev.vars, .env, or account bindings.
      main: './src/index.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-30',
        durableObjects: {
          WATCH_PARTY_ROOMS: { className: 'WatchPartyRoom', useSQLite: true },
        },
        bindings: {
          WATCH_PARTY_SECRET: TEST_SECRET,
          ALLOWED_ORIGINS: 'https://app.example.com',
        },
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});
