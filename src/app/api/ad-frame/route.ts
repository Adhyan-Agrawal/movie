import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Adsterra ad-frame document (Spec Section 11).
 *
 * Adsterra's invoke.js refuses to run inside `about:srcdoc` frames (it reads
 * window.location, which is not an http(s) URL there), so each banner unit is
 * served as a real document from this route and embedded with a normal iframe
 * src. The zone key is validated (hex token only) — nothing else is reflected
 * into the document, so the route cannot be used as an injection vector.
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') ?? '';
  const w = Number(request.nextUrl.searchParams.get('w') ?? '728');
  const h = Number(request.nextUrl.searchParams.get('h') ?? '90');

  if (!/^[a-f0-9]{16,64}$/i.test(key) || !Number.isInteger(w) || !Number.isInteger(h)) {
    return new NextResponse('Invalid ad parameters.', { status: 400 });
  }
  // Reasonable size bounds (standard IAB banner dimensions).
  if (w < 1 || w > 1920 || h < 1 || h > 1080) {
    return new NextResponse('Invalid ad size.', { status: 400 });
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head>
<body>
<script type="text/javascript">
  atOptions = {
    'key': '${key}',
    'format': 'iframe',
    'height': ${h},
    'width': ${w},
    'params': {}
  };
</script>
<script type="text/javascript" src="https://www.highperformanceformat.com/${key}/invoke.js"></script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      // This document exists to be framed by Lumora's own pages; the global
      // response headers (frame-ancestors 'none') are excluded for this path
      // in next.config.mjs. Policy here: framable only by us, and the only
      // script origin is Adsterra's invoke host.
      'Content-Security-Policy':
        "frame-ancestors 'self'; script-src 'unsafe-inline' https://www.highperformanceformat.com; frame-src https://www.highperformanceformat.com https:; img-src https: data:; style-src 'unsafe-inline';",
    },
  });
}
