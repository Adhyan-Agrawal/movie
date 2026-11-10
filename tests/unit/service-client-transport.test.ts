import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const environment = vi.hoisted(() => ({ url: '', key: 'synthetic-service-role-key' }));
vi.mock('@/lib/env', () => ({
  publicEnv: { get NEXT_PUBLIC_SUPABASE_URL() { return environment.url; } },
  serverEnv: () => ({ SUPABASE_SERVICE_ROLE_KEY: environment.key }),
}));

let origin: Server;
let redirectTarget: Server;
let redirectedRequests = 0;
const sourceRequests: Array<{ path: string; authorization?: string; apiKey?: string }> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  redirectTarget = createServer((_request, response) => {
    redirectedRequests++;
    response.end('Redirect destination must not be requested');
  });
  const destination = await listen(redirectTarget);
  origin = createServer((request, response) => {
    sourceRequests.push({ path: request.url ?? '', authorization: request.headers.authorization, apiKey: String(request.headers.apikey ?? '') });
    if (request.url?.endsWith('/redirect.m3u8')) {
      response.writeHead(302, { Location: `${destination}/capture` });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n');
  });
  environment.url = await listen(origin);
});

afterAll(async () => {
  for (const server of [origin, redirectTarget]) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('privileged Supabase transport', () => {
  it('supports real SDK streaming downloads without forwarding credentials through redirects', async () => {
    const { getSupabaseServiceClient } = await import('@/lib/supabase/service');
    const client = getSupabaseServiceClient();
    const content = await client.storage.from('media').download('hls/public-film/master.m3u8', {}, {
      cache: 'no-store', signal: new AbortController().signal,
    }).asStream();
    expect(content.error).toBeNull();
    expect(await new Response(content.data!).text()).toBe('#EXTM3U\n');

    const redirected = await client.storage.from('media').download('hls/public-film/redirect.m3u8').asStream();
    expect(redirected.data).toBeNull();
    expect(redirected.error).not.toBeNull();
    expect(redirectedRequests).toBe(0);
    expect(sourceRequests).toHaveLength(2);
    for (const request of sourceRequests) {
      expect(request.authorization).toBe(`Bearer ${environment.key}`);
      expect(request.apiKey).toBe(environment.key);
    }
  });
});
