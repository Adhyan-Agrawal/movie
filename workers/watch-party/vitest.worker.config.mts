import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const TEST_SECRET = 'test-watch-party-secret-that-is-at-least-32-bytes';
process.env.WATCH_PARTY_SECRET = TEST_SECRET;
process.env.ALLOWED_ORIGINS = 'https://app.example.com';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
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
