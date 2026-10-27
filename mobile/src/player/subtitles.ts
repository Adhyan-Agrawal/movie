export interface Cue { start: number; end: number; text: string }

function timestamp(value: string): number | null {
  if (!/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  const seconds = parts.pop()!;
  const minutes = parts.pop()!;
  if (seconds >= 60 || minutes >= 60) return null;
  return (parts.pop() ?? 0) * 3600 + minutes * 60 + seconds;
}

/** Original cue times are immutable; offsets are applied only when rendering. */
export function parseVtt(input: string): Cue[] {
  const vtt = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (vtt.length > 2 * 1024 * 1024 || !/^WEBVTT(?:[ \t]|\n|$)/.test(vtt)) return [];
  const cues: Cue[] = [];
  for (const block of vtt.split(/\n\s*\n/).slice(1)) {
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index]!);
    if (!match) continue;
    const start = timestamp(match[1]!);
    const end = timestamp(match[2]!);
    if (start === null || end === null || end <= start) continue;
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (text) cues.push({ start, end, text });
    if (cues.length >= 20000) break;
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function subtitleText(cues: Cue[], position: number, offset: number): string {
  const originalTime = position - offset;
  return cues.filter((cue) => cue.start <= originalTime && cue.end > originalTime).map((cue) => cue.text).join('\n');
}

export interface Tap { time: number; x: number; y: number; side: 'left' | 'right' }
export function doubleTap(previous: Tap | null, next: Tap): boolean {
  return !!previous && previous.side === next.side && next.time - previous.time >= 0 && next.time - previous.time <= 300
    && Math.hypot(previous.x - next.x, previous.y - next.y) <= 16;
}
