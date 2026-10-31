import { NextRequest, NextResponse } from 'next/server';
import {
  parseIntroCatalogRequest,
  resolveIntroMarker,
  type IntroCatalogResponse,
} from '@/features/player/intro-markers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function response(body: IntroCatalogResponse, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const input = parseIntroCatalogRequest(request.nextUrl.searchParams);
  if (!input) return response({ intro: null }, 400);

  try {
    const result = await resolveIntroMarker(input);
    return response({ intro: result.status === 'positive' ? result.intro : null });
  } catch {
    return response({ intro: null });
  }
}
