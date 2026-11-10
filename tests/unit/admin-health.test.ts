import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  permission: vi.fn(), headers: vi.fn(), fetch: vi.fn(), refresh: vi.fn(), configs: vi.fn(), adapter: vi.fn(), probe: vi.fn(), reports: vi.fn(),
  features: { supabaseConfigured: false, tmdbConfigured: true },
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/permissions/check', () => ({ hasPermission: mocks.permission }));
vi.mock('@/lib/providers/registry', () => ({ getAdapter: mocks.adapter, getActiveProviderConfigs: mocks.configs, refreshProviderRegistry: mocks.refresh }));
vi.mock('@/features/admin/queries', () => ({ listPlaybackReports: mocks.reports }));

import AdminHealthPage from '@/app/admin/health/page';
import { GET } from '@/app/api/health/route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.permission.mockResolvedValue(true);
  mocks.headers.mockImplementation(() => { throw new Error('Forwarded headers must not select a fetch destination'); });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.configs.mockReturnValue([{ id: 'current-db-provider' }]);
  mocks.adapter.mockReturnValue({ healthCheck: mocks.probe });
  mocks.probe.mockResolvedValue({ providerId: 'current-db-provider', status: 'healthy', latencyMs: 3, checkedAt: '2026-11-08T00:00:00Z' });
  mocks.reports.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('protected in-process admin diagnostics', () => {
  it('uses the current request permission without a self-fetch or forwarded-host dependency', async () => {
    const html = renderToStaticMarkup(await AdminHealthPage());
    expect(mocks.permission).toHaveBeenCalledWith('health.read');
    expect(html).toContain('supabase');
    expect(html).toContain('unconfigured');
    expect(html).toMatch(/>configured</);
    expect(html).toContain('current-db-provider');
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.adapter).toHaveBeenCalledWith('current-db-provider');
    expect(mocks.headers).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects the page before provider/report work when health permission is absent', async () => {
    mocks.permission.mockResolvedValue(false);
    await expect(AdminHealthPage()).rejects.toThrow('not-found');
    for (const call of [mocks.refresh, mocks.configs, mocks.adapter, mocks.probe, mocks.reports, mocks.headers, mocks.fetch]) expect(call).not.toHaveBeenCalled();
  });

  it('keeps the public endpoint minimal and non-cacheable without health permission', async () => {
    mocks.permission.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: { status: 'ok' }, error: null, requestId: expect.any(String) });
  });

  it('does not expose private errors from a failed detail check', async () => {
    mocks.permission.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('synthetic-private-detail'));
    const html = renderToStaticMarkup(await AdminHealthPage());
    expect(html).toContain('Service status unavailable');
    expect(html).not.toContain('synthetic-private-detail');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('labels failed provider probes as unknown without presenting playback readiness', async () => {
    mocks.probe.mockRejectedValue(new Error('synthetic-private-provider-error'));
    const html = renderToStaticMarkup(await AdminHealthPage());
    expect(html).toContain('Health check failed.');
    expect(html).not.toContain('synthetic-private-provider-error');
    expect(html).toContain('not proof of working video playback');
  });
});
