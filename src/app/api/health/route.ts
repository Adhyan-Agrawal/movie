import { NextResponse } from 'next/server';
import { features } from '@/lib/env';
import { hasPermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';

/**
 * Health endpoint (Sections 14/15). Reports configuration/liveness of core
 * dependencies. Returns 200 when the app is up; individual checks may be
 * "unconfigured" in mock mode without failing the overall status.
 *
 * Liveness is public, but the detailed dependency state is privileged
 * (`health.read`, Section 8). Callers without it get the minimal liveness
 * payload — a plain 200 rather than a 403, so the response never confirms
 * which permission guards the detail.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const requestId = crypto.randomUUID();

  const detailed = await hasPermission(PERMISSIONS.HEALTH_READ);
  if (!detailed) {
    return NextResponse.json(
      { data: { status: 'ok' }, error: null, requestId },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  const checks = {
    app: 'ok' as const,
    supabase: features.supabaseConfigured ? ('ok' as const) : ('unconfigured' as const),
    tmdb: features.tmdbConfigured ? ('ok' as const) : ('unconfigured' as const),
  };

  return NextResponse.json(
    {
      data: { status: 'ok', checks, time: new Date().toISOString() },
      error: null,
      requestId,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
