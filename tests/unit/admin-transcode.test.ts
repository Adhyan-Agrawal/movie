import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  permission: vi.fn(), service: vi.fn(), cliImport: vi.fn(), probe: vi.fn(), transcode: vi.fn(),
  pagePermission: vi.fn(), candidates: vi.fn(), titles: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/permissions/check', () => ({ requirePermission: mocks.permission, hasPermission: mocks.pagePermission }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
vi.mock('@/features/admin/queries', () => ({ listTranscodeCandidates: mocks.candidates, listAdminTitles: mocks.titles }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('../../scripts/transcode-hls.mjs', () => {
  mocks.cliImport();
  return { isFfmpegAvailable: mocks.probe, transcodeToHls: mocks.transcode, RENDITIONS: [] };
});

import { transcodeUploadAction } from '@/features/admin/transcode-actions';
import { TranscodePanel } from '@/features/admin/TranscodePanel';
import { TRANSCODE_INITIAL_STATE, TRANSCODE_OFFLINE_COMMAND, TRANSCODE_UNAVAILABLE_MESSAGE } from '@/features/admin/transcode-state';
import AdminTranscodePage from '@/app/admin/sources/transcode/page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FFMPEG_PATH', 'synthetic-offline-ffmpeg');
  vi.stubEnv('FFPROBE_PATH', 'synthetic-offline-ffprobe');
  mocks.permission.mockResolvedValue(undefined);
  mocks.pagePermission.mockResolvedValue(true);
  mocks.probe.mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function upload() {
  const form = new FormData();
  const title = '00000000-0000-4000-8000-000000000001';
  form.set('titleId', title);
  form.set('path', `media/${title}/title/input.mp4`);
  form.set('executor', 'node');
  form.set('FFMPEG_PATH', '/pretend/binary');
  return form;
}

describe('serverless web transcode boundary', () => {
  it('returns unavailable for direct submissions even when binary paths are configured', async () => {
    expect(await transcodeUploadAction(TRANSCODE_INITIAL_STATE, upload())).toEqual({
      status: 'error', message: TRANSCODE_UNAVAILABLE_MESSAGE,
    });
    expect(mocks.permission).toHaveBeenCalledWith('provider.manage');
    expect(mocks.cliImport).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.transcode).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(TRANSCODE_UNAVAILABLE_MESSAGE).toContain(TRANSCODE_OFFLINE_COMMAND);
    expect(TRANSCODE_UNAVAILABLE_MESSAGE).toContain('separately authorized executor');
    expect(TRANSCODE_UNAVAILABLE_MESSAGE).toContain('No job was started');
  });

  it('retains the permission gate and does not echo permission failure details', async () => {
    mocks.permission.mockRejectedValue(new Error('synthetic-private-error'));
    expect(await transcodeUploadAction(TRANSCODE_INITIAL_STATE, upload())).toEqual({
      status: 'error', message: 'You need the provider.manage permission to transcode media.',
    });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('does not treat malformed form fields or a previous success as an execution bypass', async () => {
    const result = await transcodeUploadAction({ status: 'ok', message: 'forged prior success', masterPath: 'old/path' }, new FormData());
    expect(result).toEqual({ status: 'error', message: TRANSCODE_UNAVAILABLE_MESSAGE });
    expect(result).not.toHaveProperty('masterPath');
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('keeps the gate closed in local web development too; only the CLI owns Node execution', async () => {
    vi.unstubAllGlobals();
    expect((await transcodeUploadAction(TRANSCODE_INITIAL_STATE, upload())).status).toBe('error');
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.transcode).not.toHaveBeenCalled();
  });

  it('has no binary, filesystem, storage or CLI dependency in the executable web action', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      absWorkingDir: root, entryPoints: ['src/features/admin/transcode-actions.ts'],
      bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true, logLevel: 'silent',
      plugins: [{ name: 'transcode-boundary', setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === '@/lib/permissions/check') return { path: args.path, namespace: 'test-permission' };
          if (/^(node:|@\/lib\/supabase\/)|transcode-hls/.test(args.path)) throw new Error(`Forbidden web dependency: ${args.path}`);
        });
        builder.onLoad({ filter: /.*/, namespace: 'test-permission' }, () => ({ contents: 'export async function requirePermission() {}' }));
      } }],
    });
    expect(Object.keys(result.metafile!.inputs).some((path) => /transcode-actions\.ts$/.test(path))).toBe(true);
    expect(Object.keys(result.metafile!.inputs).some((path) => /transcode-hls|node:|supabase/.test(path))).toBe(false);
  });

  it('renders disabled guidance instead of an upload or executable transcode form', () => {
    const html = renderToStaticMarkup(createElement(TranscodePanel));
    expect(html).toContain('Web transcoding unavailable on this deployment');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="file"');
    expect(html).toContain('node scripts/transcode-hls.mjs');
    expect(html).toContain('does not upload');
    expect(html).toContain('separately authorized executor');
    expect(html).toContain('href="/admin/sources"');
  });

  it('renders the permission-gated page without loading private media or title lists', async () => {
    const html = renderToStaticMarkup(await AdminTranscodePage());
    expect(mocks.pagePermission).toHaveBeenCalledWith('provider.manage');
    expect(html).toContain('no job will be started here');
    expect(html).toContain('Web transcoding unavailable on this deployment');
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.titles).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('keeps the guidance route hidden from users without permission', async () => {
    mocks.pagePermission.mockResolvedValue(false);
    await expect(AdminTranscodePage()).rejects.toThrow('not-found');
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.titles).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
});

it('preserves the independent Node CLI exports and local rendition construction without executing a binary', async () => {
  const cli = await vi.importActual<typeof import('../../scripts/transcode-hls.mjs')>('../../scripts/transcode-hls.mjs');
  expect(typeof cli.transcodeToHls).toBe('function');
  expect(typeof cli.isFfmpegAvailable).toBe('function');
  expect(cli.RENDITIONS.map((rendition) => rendition.height)).toEqual([1080, 720, 480]);
  const args = cli.buildFfmpegArgs({ inputPath: 'synthetic.mp4', outputDir: 'synthetic-output' });
  expect(args).toContain('synthetic.mp4');
  expect(args).toContain('-var_stream_map');
  expect(cli.renderMasterPlaylist({})).toContain('1080/index.m3u8');
  expect(cli.renderMasterPlaylist({})).toContain('720/index.m3u8');
  expect(cli.renderMasterPlaylist({})).toContain('480/index.m3u8');
});
