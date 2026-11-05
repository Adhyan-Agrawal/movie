const MAX_METADATA_BYTES = 64 * 1024;

export async function readTrailerJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null;
  if (signal.aborted || Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Trailer metadata unavailable.');
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Trailer lookup aborted.', 'AbortError');
      const chunk = await reader.read();
      if (signal.aborted) throw new DOMException('Trailer lookup aborted.', 'AbortError');
      if (chunk.done) return JSON.parse(text + decoder.decode());
      bytes += chunk.value.byteLength;
      if (bytes > MAX_METADATA_BYTES) throw new Error('Trailer metadata exceeds its size limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
