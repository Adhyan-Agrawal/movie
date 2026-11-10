import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default defineConfig({
  ...base,
  envDir: false,
  test: {
    ...base.test,
    maxWorkers: 2,
    include: [
      'tests/unit/request-ip.test.ts',
      'tests/unit/env.test.ts',
      'tests/unit/vidnest-auto.test.ts',
      'tests/unit/vidnest-coldstart.test.ts',
      'tests/unit/vidnest-catalog.test.ts',
      'tests/unit/vidnest-proxy.test.ts',
      'tests/unit/wyzie-route.test.ts',
      'tests/unit/wyzie-subtitles.test.ts',
      'tests/unit/discovery-tmdb.test.ts',
      'tests/unit/direct-public-metadata.test.ts',
      'tests/unit/tmdb-title-outage.test.ts',
      'tests/unit/episode-navigation-tmdb.test.ts',
      'tests/unit/public-catalog-edge-cache.test.ts',
      'tests/unit/admin-transcode.test.ts',
      'tests/unit/watch-party-web-config.test.ts',
      'tests/unit/account-availability.test.ts',
    ],
  },
});
