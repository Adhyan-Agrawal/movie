/** Keep one declared video rendition without removing its audio/subtitle groups. */
export function selectHlsRendition(playlist: string, renditionId: string): string | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(renditionId)) return null;
  const lines = playlist.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '#EXTM3U') return null;
  const variants: Array<{ declaration: number; uri: number }> = [];
  const declarations = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]!.trim().startsWith('#EXT-X-STREAM-INF:')) continue;
    declarations.add(index);
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!.trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) break;
      if (line && !line.startsWith('#')) { variants.push({ declaration: index, uri: next }); break; }
    }
  }
  const selected = variants[Number(renditionId)];
  if (!selected) return null;
  const excluded = new Set(declarations);
  excluded.delete(selected.declaration);
  for (const variant of variants) if (variant !== selected) excluded.add(variant.uri);
  return lines.filter((_, index) => !excluded.has(index)).join('\n');
}
