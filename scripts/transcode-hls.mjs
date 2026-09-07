#!/usr/bin/env node
/**
 * transcode-hls.mjs — turn one media file into an adaptive HLS ladder.
 *
 * Runs ffmpeg (spawned via node:child_process — no new npm deps) to produce
 * 1080p / 720p / 480p HLS renditions plus a variant ("master") playlist:
 *
 *   <outputDir>/
 *     1080/index.m3u8   1080/seg_0000.ts …   (rendition 1)
 *     720/index.m3u8    720/seg_0000.ts …    (rendition 2)
 *     480/index.m3u8    480/seg_0000.ts …    (rendition 3)
 *     master.m3u8                            (variant playlist -> each rendition)
 *
 * One ffmpeg invocation drives all three renditions via `-var_stream_map`: the
 * video is split once and each branch scaled to its rendition height (`%v` in
 * the output/segment patterns expands to each variant's `name:`, which is what
 * creates the 1080/720/480 subdirectories).
 *
 * ffmpeg must be installed on the server:
 *   Ubuntu/Debian   : sudo apt-get install ffmpeg
 *   macOS (Homebrew): brew install ffmpeg
 *   Windows         : winget install Gyan.FFmpeg  (then put ffmpeg.exe on PATH)
 * The binary is resolved from $FFMPEG_PATH (and $FFPROBE_PATH for ffprobe) when
 * set, otherwise from PATH. When it is missing the module throws an honest
 * "ffmpeg not installed" error instead of pretending the transcode happened.
 *
 * Runnable standalone:
 *   node scripts/transcode-hls.mjs <input.mp4> [outputDir]
 * and importable by the admin server action:
 *   import { transcodeToHls, isFfmpegAvailable } from '../../../scripts/transcode-hls.mjs';
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The HLS ladder. `height` drives both the scale filter and the master
 * playlist RESOLUTION; maxrate/bufsize are H.264 VBR caps chosen for smooth
 * ABR (CRF keeps per-rendition quality), `bandwidth` is the peak declared to
 * players for variant selection.
 * @typedef {{ name: string; height: number; widthFallback: number; crf: string; maxrate: string; bufsize: string; audioBitrate: string; bandwidth: number }} Rendition
 * @type {Rendition[]}
 */
export const RENDITIONS = [
  { name: '1080', height: 1080, widthFallback: 1920, crf: '20', maxrate: '5350k', bufsize: '8000k', audioBitrate: '192k', bandwidth: 5_500_000 },
  { name: '720', height: 720, widthFallback: 1280, crf: '21', maxrate: '2996k', bufsize: '4500k', audioBitrate: '128k', bandwidth: 3_100_000 },
  { name: '480', height: 480, widthFallback: 854, crf: '23', maxrate: '1498k', bufsize: '2250k', audioBitrate: '96k', bandwidth: 1_550_000 },
];

/** Generous cap: a feature film takes a while even on a fast box. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** ffmpeg/ffprobe resolve through these env overrides first, then PATH. */
const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH ?? 'ffprobe';

const FFMPEG_MISSING_MESSAGE =
  'ffmpeg is not installed on this server. Install it and retry ' +
  '(Ubuntu/Debian: `sudo apt-get install ffmpeg` · macOS: `brew install ffmpeg` · ' +
  'Windows: `winget install Gyan.FFmpeg`), or point FFMPEG_PATH at the binary.';

/**
 * Resolve `binary` to a runnable command, or null when unavailable. A
 * `spawnSync(binary, ['-version'])` with stdio ignored is the cheapest reliable
 * "is it installed" probe — it exits non-zero and surfaces ENOENT when the
 * binary is not on PATH.
 * @param {string} binary - binary name to look for ('ffmpeg' | 'ffprobe').
 * @param {string} envOverride - $FFMPEG_PATH / $FFPROBE_PATH value ('' when unset).
 * @returns {string | null} the command to spawn, or null when unavailable.
 */
export function findBinary(binary, envOverride) {
  const cmd = envOverride || binary;
  let result;
  try {
    result = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  if (result.error && result.error.code === 'ENOENT') return null;
  if (result.status !== 0) return null;
  return cmd;
}

/** True when an ffmpeg binary is installed and runnable on this server. */
export function isFfmpegAvailable() {
  return findBinary('ffmpeg', FFMPEG_BIN) !== null;
}

/**
 * Probe a media file for the bits the ladder needs: video width/height (to
 * compute each rendition's exact RESOLUTION for the master playlist), whether
 * an audio stream exists (to build `-map`/`-var_stream_map` correctly), and the
 * duration (for progress percentages).
 *
 * Returns null when ffprobe is unavailable or the file cannot be probed — the
 * pipeline still runs, falling back to 16:9 widths and an unknown duration.
 * @param {string} inputPath
 * @returns {{ width: number; height: number; hasAudio: boolean; durationSeconds: number | null } | null}
 */
export function probeMedia(inputPath) {
  const ffprobe = findBinary('ffprobe', FFPROBE_BIN);
  if (!ffprobe) return null;

  const result = spawnSync(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return null;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const streams = parsed?.streams ?? [];
  const video = streams.find((s) => s?.codec_type === 'video');
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const duration = Number.parseFloat(parsed?.format?.duration);
  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    hasAudio: Boolean(audio),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/**
 * Build the ffmpeg argument vector for the HLS ladder.
 *
 * `hasAudio` drives whether each rendition maps + re-encodes the source audio
 * (probed so audio-less inputs produce audio-less renditions instead of a
 * var_stream_map that references a missing audio map).
 * @param {{ inputPath: string; outputDir: string; renditions?: Rendition[]; hasAudio?: boolean }} opts
 * @returns {string[]} argv for `spawn(ffmpeg, argv)`.
 */
export function buildFfmpegArgs({ inputPath, outputDir, renditions = RENDITIONS, hasAudio = true }) {
  const splitLabels = renditions.map((_, i) => `[v${i + 1}]`).join('');
  const scaleChain = renditions.map((r, i) => `[v${i + 1}]scale=-2:${r.height}[v${i + 1}out]`).join(';');
  const filterComplex = `[0:v]split=${renditions.length}${splitLabels};${scaleChain}`;

  const args = ['-hide_banner', '-y', '-i', inputPath, '-filter_complex', filterComplex];

  renditions.forEach((r, i) => {
    args.push('-map', `[v${i + 1}out]`);
    if (hasAudio) args.push('-map', '0:a:0?');
    args.push(
      `-c:v:${i}`, 'libx264',
      `-profile:v:${i}`, 'main',
      `-crf:v:${i}`, r.crf,
      `-maxrate:v:${i}`, r.maxrate,
      `-bufsize:v:${i}`, r.bufsize,
    );
    if (hasAudio) {
      args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, r.audioBitrate, `-ac:${i}`, '2');
    }
  });

  const streamMap = renditions
    .map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ');

  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', resolve(outputDir, '%v', 'seg_%04d.ts'),
    '-var_stream_map', streamMap,
    // Machine-readable progress on stdout (parsed for onProgress); the default
    // human stats still stream to stderr.
    '-progress', 'pipe:1',
    resolve(outputDir, '%v', 'index.m3u8'),
  );
  return args;
}

/**
 * Render the master playlist. RESOLUTION is derived from the probed source
 * aspect ratio when known (scale=-2 keeps the source aspect, so the width is
 * computed from the fixed target height), otherwise a 16:9 fallback.
 * @param {{ renditions?: Rendition[]; sourceWidth?: number; sourceHeight?: number }} opts
 * @returns {string} master.m3u8 contents.
 */
export function renderMasterPlaylist({ renditions = RENDITIONS, sourceWidth = 0, sourceHeight = 0 }) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of renditions) {
    const width =
      sourceWidth > 0 && sourceHeight > 0
        ? Math.round((sourceWidth * r.height) / sourceHeight / 2) * 2
        : r.widthFallback;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${Math.round(r.bandwidth * 0.55)},RESOLUTION=${width}x${r.height},NAME="${r.name}"`,
      `${r.name}/index.m3u8`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Transcode `inputPath` into the HLS ladder under `outputDir` and write the
 * master playlist. Throws with an honest message when ffmpeg is missing, fails,
 * or exceeds the timeout.
 *
 * @param {{ inputPath: string; outputDir: string; onProgress?: (info: { timeSeconds: number; percent?: number; frame?: number; fps?: number }) => void; signal?: AbortSignal; timeoutMs?: number }} opts
 * @returns {Promise<{ masterPath: string; outputDir: string; durationSeconds: number | null; renditions: Array<{ name: string; height: number; width: number; playlistPath: string }> }>}
 */
export async function transcodeToHls({
  inputPath,
  outputDir,
  onProgress,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const ffmpeg = findBinary('ffmpeg', FFMPEG_BIN);
  if (!ffmpeg) throw new Error(FFMPEG_MISSING_MESSAGE);

  const probe = probeMedia(inputPath);
  const hasAudio = probe ? probe.hasAudio : true;

  // Pre-create the variant directories so `%v` never has to.
  await Promise.all(RENDITIONS.map((r) => mkdir(resolve(outputDir, r.name), { recursive: true })));

  const args = buildFfmpegArgs({ inputPath, outputDir, renditions: RENDITIONS, hasAudio });
  await runFfmpeg(ffmpeg, args, {
    onProgress,
    signal,
    timeoutMs,
    durationSeconds: probe?.durationSeconds ?? null,
  });

  const sourceWidth = probe?.width ?? 0;
  const sourceHeight = probe?.height ?? 0;
  const masterPath = resolve(outputDir, 'master.m3u8');
  await writeFile(masterPath, renderMasterPlaylist({ renditions: RENDITIONS, sourceWidth, sourceHeight }), 'utf8');

  return {
    masterPath,
    outputDir,
    durationSeconds: probe?.durationSeconds ?? null,
    renditions: RENDITIONS.map((r) => ({
      name: r.name,
      height: r.height,
      width:
        sourceWidth > 0 && sourceHeight > 0
          ? Math.round((sourceWidth * r.height) / sourceHeight / 2) * 2
          : r.widthFallback,
      playlistPath: resolve(outputDir, r.name, 'index.m3u8'),
    })),
  };
}

/**
 * Spawn ffmpeg and resolve when it exits 0. ffmpeg's default progress stats are
 * streamed through to THIS process's stderr (the natural server log channel);
 * the `-progress pipe:1` key=value lines on stdout are parsed for `onProgress`.
 * Kills the child on timeout or abort.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ onProgress?: (info: { timeSeconds: number; percent?: number; frame?: number; fps?: number }) => void; signal?: AbortSignal; timeoutMs: number; durationSeconds: number | null }} opts
 * @returns {Promise<void>}
 */
function runFfmpeg(bin, args, { onProgress, signal, timeoutMs, durationSeconds }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    const abort = () => child.kill('SIGKILL');

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (err) reject(err);
      else resolvePromise();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line || line === 'progress=end') continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (!onProgress || key === 'progress') continue;
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const timeSeconds =
            key === 'out_time_us' ? Number(value) / 1_000_000 : Number(value) / 1000;
          onProgress({
            timeSeconds: Number.isFinite(timeSeconds) ? timeSeconds : 0,
            percent:
              durationSeconds && durationSeconds > 0
                ? Math.min(100, (timeSeconds / durationSeconds) * 100)
                : undefined,
          });
        } else if (key === 'frame' || key === 'fps') {
          const n = Number.parseFloat(value);
          onProgress({ timeSeconds: 0, ...(key === 'frame' ? { frame: n } : { fps: n }) });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      // Stream ffmpeg's own progress/log lines to the server log (stderr).
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-4000); // keep a tail for error messages
    });

    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
      finish(new Error(`ffmpeg exited with code ${code}.${tail ? `\n${tail}` : ''}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Standalone CLI: node scripts/transcode-hls.mjs <input.mp4> [outputDir]
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] ?? resolve(process.cwd(), 'hls-output');

  if (!inputPath) {
    console.error('usage: node scripts/transcode-hls.mjs <input.mp4> [outputDir]');
    process.exit(2);
  }

  transcodeToHls({
    inputPath,
    outputDir,
    onProgress: ({ percent, timeSeconds }) => {
      const label = percent != null ? `${percent.toFixed(0)}%` : `${timeSeconds.toFixed(1)}s`;
      process.stderr.write(`\rtranscoding… ${label}          `);
    },
  })
    .then((result) => {
      process.stderr.write('\n');
      console.log(`Master playlist: ${result.masterPath}`);
      for (const r of result.renditions) console.log(`  ${r.name}p: ${r.playlistPath}`);
    })
    .catch((err) => {
      process.stderr.write('\n');
      console.error(`transcode failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
