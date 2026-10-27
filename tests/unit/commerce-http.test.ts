import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/features/commerce/auth', () => ({ commerceIdentity: vi.fn() }));
vi.mock('@/features/commerce/queries', () => ({ invalidatePlaybackPolicy: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: vi.fn() }));
vi.mock('@/lib/env', () => ({ publicEnv: {} }));
import { commerceFailure, commerceResponse, readCommerceMutation } from '@/features/commerce/http';
import { CommerceError } from '@/features/commerce/admin';

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('https://app.example.com/api/plans', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.com', ...headers }, body });
}

describe('commerce request boundaries', () => {
  it('uses no-store and varies personal responses by both cookie and bearer', () => {
    const response = commerceResponse({ resolved: true });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });
  it('rejects cross-origin writes even when a bearer is present', async () => {
    await expect(readCommerceMutation(request('{}', { origin: 'https://evil.example.com', authorization: 'Bearer token' }))).rejects.toMatchObject({ status: 403 });
  });
  it('requires explicit origin for cookie mutations', async () => {
    const input = request('{}'); input.headers.delete('origin');
    await expect(readCommerceMutation(input)).rejects.toMatchObject({ status: 403 });
  });
  it('allows native bearer JSON requests for later validation by the identity service', async () => {
    const input = request('{"operation":"create"}', { authorization: 'Bearer token' }); input.headers.delete('origin');
    expect(await readCommerceMutation(input)).toEqual({ operation: 'create' });
  });
  it('rejects non-JSON bodies', async () => {
    await expect(readCommerceMutation(request('{}', { 'content-type': 'text/plain' }))).rejects.toMatchObject({ status: 415 });
  });
  it('caps the actual streamed body, without relying on Content-Length', async () => {
    await expect(readCommerceMutation(request(JSON.stringify({ data: 'x'.repeat(16385) })))).rejects.toMatchObject({ status: 413 });
  });
  it('rejects invalid JSON with a controlled error', async () => {
    await expect(readCommerceMutation(request('{'))).rejects.toMatchObject({ status: 400 });
  });
  it('sanitizes unknown errors without leaking provider or database details', async () => {
    const response = commerceFailure(new Error('postgres private secret'));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain('private secret');
    expect(commerceFailure(new CommerceError('Forbidden.', 403)).status).toBe(403);
  });
});
