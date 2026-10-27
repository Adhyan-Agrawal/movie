import { CommerceError } from './admin';

export function commerceResponse(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie, Authorization' } });
}

export function commerceFailure(error: unknown) {
  return commerceResponse({ error: error instanceof CommerceError ? error.message : 'Commerce is temporarily unavailable.' },
    error instanceof CommerceError ? error.status : 503);
}

export async function readCommerceMutation(request: Request): Promise<unknown> {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || (!origin && !request.headers.get('authorization'))) {
    throw new CommerceError('A same-origin request is required.', 403);
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CommerceError('JSON is required.', 415);
  }
  if (!request.body) throw new CommerceError('Request body required.', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new CommerceError('Request is too large.', 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new CommerceError('Invalid JSON.', 400); }
  } finally { reader.releaseLock(); }
}
