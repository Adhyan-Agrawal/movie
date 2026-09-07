'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { Title } from '@/features/catalog/types';
import type { AdminMediaSourceRow } from './types';
import {
  addRemoteSourceAction,
  confirmUploadedSourceAction,
  createUploadTicketAction,
  deleteSourceAction,
  toggleSourceAction,
} from './sources-actions';

/**
 * Admin media upload + source management (Spec Sections 7, 9, 11) for ONE
 * title. Everything here talks to permission-gated server actions; the actual
 * file bytes never touch the app server — the browser PUTs them straight to a
 * time-limited signed UPLOAD URL in the private `media` bucket, and the row is
 * only inserted after the server has verified the object exists.
 */

/** Client-side guard: 10 GB per upload (storage-side limits still apply). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/** Kind options for the remote-source form; 'auto' infers from the URL. */
const REMOTE_KIND_OPTIONS = ['auto', 'hls', 'mp4', 'dash', 'custom'] as const;

const inputClasses =
  'h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none';

const labelClasses = 'flex flex-col gap-1.5 text-xs text-content-muted';

export interface SourcesEpisodeOption {
  id: string;
  /** Human label, e.g. "S1 · E3 · Episode name". */
  label: string;
}

type UploadPhase = 'idle' | 'ticketing' | 'uploading' | 'confirming' | 'done';

// ---------------------------------------------------------------------------
// Per-source row (toggle + two-step delete)
// ---------------------------------------------------------------------------

function SourceRow({ source }: { source: AdminMediaSourceRow }) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await toggleSourceAction(source.id, !source.enabled);
      if (!result.ok) setError(result.error ?? 'Could not update the source.');
      else router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteSourceAction(source.id);
      if (!result.ok) {
        setError(result.error ?? 'Could not delete the source.');
        setConfirmDelete(false);
      } else {
        router.refresh();
      }
    });
  }

  const isStorage = source.reference != null && source.reference !== '';

  return (
    <tr className="border-b border-border last:border-b-0">
      <th scope="row" className="max-w-[16rem] truncate px-3 py-2.5 text-left text-sm font-medium text-content">
        {source.label || <span className="text-content-subtle">—</span>}
      </th>
      <td className="px-3 py-2.5 text-sm">
        <Badge tone="primary">{source.kind}</Badge>
      </td>
      <td className="px-3 py-2.5 text-sm text-content-muted">{source.language}</td>
      <td className="px-3 py-2.5 text-sm text-content-muted">{source.quality}</td>
      <td className="px-3 py-2.5 text-sm tabular-nums text-content-muted">{source.priority}</td>
      <td className="px-3 py-2.5 text-sm">
        <Badge tone={isStorage ? 'info' : 'neutral'}>{isStorage ? 'Storage' : 'Remote'}</Badge>
      </td>
      <td className="px-3 py-2.5 text-sm">
        <Badge tone={source.enabled ? 'success' : 'warning'}>{source.enabled ? 'Enabled' : 'Disabled'}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="secondary" disabled={pending} onClick={toggle}>
              {source.enabled ? 'Disable' : 'Enable'}
            </Button>
            {confirmDelete ? (
              <>
                <Button size="sm" variant="primary" disabled={pending} onClick={remove}>
                  Confirm delete
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
                className="text-danger hover:bg-danger/10 hover:text-danger"
              >
                Delete
              </Button>
            )}
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// SourcesManager
// ---------------------------------------------------------------------------

export function SourcesManager({
  title,
  episodes,
  sources,
}: {
  title: Pick<Title, 'id' | 'name' | 'type' | 'releaseYear'>;
  episodes: SourcesEpisodeOption[];
  sources: AdminMediaSourceRow[];
}) {
  const router = useRouter();

  // --- Upload form state -----------------------------------------------------
  const [file, setFile] = useState<File | null>(null);
  const [uploadEpisode, setUploadEpisode] = useState('');
  const [uploadLabel, setUploadLabel] = useState('');
  const [uploadLanguage, setUploadLanguage] = useState('en');
  const [uploadQuality, setUploadQuality] = useState('auto');
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0); // 0..100
  const [uploadError, setUploadError] = useState<string | null>(null);

  // --- Remote form state -----------------------------------------------------
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteKind, setRemoteKind] = useState<(typeof REMOTE_KIND_OPTIONS)[number]>('auto');
  const [remoteLabel, setRemoteLabel] = useState('');
  const [remoteSeason, setRemoteSeason] = useState('');
  const [remoteEpisode, setRemoteEpisode] = useState('');
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remotePending, startRemoteTransition] = useTransition();

  const uploadBusy = phase === 'ticketing' || phase === 'uploading' || phase === 'confirming';

  /** PUT the file bytes to the signed upload URL, tracking progress via XHR. */
  function putToSignedUrl(uploadUrl: string, payload: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', payload.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — the network connection was interrupted.'));
      xhr.onabort = () => reject(new Error('Upload cancelled.'));
      xhr.send(payload);
    });
  }

  function upload() {
    if (!file) {
      setUploadError('Choose a video file first.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('That file is larger than the 10 GB upload limit.');
      return;
    }

    setUploadError(null);
    setProgress(0);
    setPhase('ticketing');
    (async () => {
      try {
        const ticket = await createUploadTicketAction({
          titleId: title.id,
          episodeId: uploadEpisode || undefined,
          filename: file.name,
          contentType: file.type || undefined,
        });
        if (!ticket.ok || !ticket.path || !ticket.uploadUrl) {
          throw new Error(ticket.error ?? 'Could not create the upload ticket.');
        }

        setPhase('uploading');
        await putToSignedUrl(ticket.uploadUrl, file);

        setPhase('confirming');
        const confirmed = await confirmUploadedSourceAction({
          titleId: title.id,
          episodeId: uploadEpisode || undefined,
          path: ticket.path,
          label: uploadLabel || file.name,
          language: uploadLanguage,
          quality: uploadQuality,
        });
        if (!confirmed.ok) throw new Error(confirmed.error ?? 'Could not register the uploaded file.');

        setPhase('done');
        setFile(null);
        setUploadLabel('');
        setUploadEpisode('');
        setUploadLanguage('en');
        setUploadQuality('auto');
        router.refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'The upload failed.');
      } finally {
        setPhase('idle');
        setProgress(0);
      }
    })();
  }

  function addRemote() {
    setRemoteError(null);
    startRemoteTransition(async () => {
      const result = await addRemoteSourceAction({
        titleId: title.id,
        url: remoteUrl,
        kind: remoteKind === 'auto' ? undefined : remoteKind,
        label: remoteLabel,
        // Optional season+episode pair, resolved to an episode id server-side
        // (the action calls findEpisodeId). Blank = whole title.
        season: remoteSeason ? Number(remoteSeason) : undefined,
        episode: remoteEpisode ? Number(remoteEpisode) : undefined,
      });
      if (!result.ok) {
        setRemoteError(result.error ?? 'Could not add the source.');
      } else {
        setRemoteUrl('');
        setRemoteLabel('');
        setRemoteKind('auto');
        setRemoteSeason('');
        setRemoteEpisode('');
        router.refresh();
      }
    });
  }

  const phaseLabel: Record<UploadPhase, string> = {
    idle: 'Idle',
    ticketing: 'Preparing upload…',
    uploading: `Uploading… ${progress}%`,
    confirming: 'Verifying upload…',
    done: 'Uploaded',
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Existing sources ------------------------------------------------- */}
      <section aria-labelledby="sources-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="sources-heading" className="text-lg font-semibold">
            Sources
          </h2>
          <p className="text-sm text-content-muted">
            {sources.length === 0
              ? 'No sources yet — upload a file or add a remote stream below.'
              : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}, highest priority first.`}
          </p>
        </div>

        {sources.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface/50 shadow-soft">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">
                Media sources for {title.name}, ordered by priority
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2 font-medium">Label</th>
                  <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                  <th scope="col" className="px-3 py-2 font-medium">Language</th>
                  <th scope="col" className="px-3 py-2 font-medium">Quality</th>
                  <th scope="col" className="px-3 py-2 font-medium">Priority</th>
                  <th scope="col" className="px-3 py-2 font-medium">Origin</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* Upload form ------------------------------------------------------- */}
      <section
        aria-labelledby="upload-heading"
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface/50 p-4 shadow-soft"
      >
        <div className="flex flex-col gap-1">
          <h2 id="upload-heading" className="text-sm font-semibold">
            Upload a video file
          </h2>
          <p className="text-xs text-content-muted">
            Files are uploaded directly to Lumora&apos;s private storage — they are never public; playback hands viewers a
            time-limited signed URL. Maximum size 10 GB.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            upload();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor="upload-file" className={cn(labelClasses, 'min-w-56 flex-1')}>
              <span>Video file</span>
              <input
                id="upload-file"
                type="file"
                accept="video/*,.m3u8,.mpd"
                disabled={uploadBusy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-content file:mr-3 file:rounded-sm file:border-0 file:bg-primary/15 file:px-2 file:py-1 file:text-xs file:font-medium file:text-primary focus-visible:outline-none focus-visible:border-primary"
              />
            </label>

            {episodes.length > 0 ? (
              <label htmlFor="upload-episode" className={cn(labelClasses, 'min-w-56')}>
                <span>Episode (for series)</span>
                <select
                  id="upload-episode"
                  value={uploadEpisode}
                  onChange={(e) => setUploadEpisode(e.target.value)}
                  disabled={uploadBusy}
                  className={inputClasses}
                >
                  <option value="">Whole title / movie</option>
                  {episodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor="upload-label" className={cn(labelClasses, 'w-48')}>
              <span>Label</span>
              <input
                id="upload-label"
                type="text"
                value={uploadLabel}
                onChange={(e) => setUploadLabel(e.target.value)}
                disabled={uploadBusy}
                maxLength={120}
                placeholder="e.g. 1080p original upload"
                className={inputClasses}
              />
            </label>
            <label htmlFor="upload-language" className={cn(labelClasses, 'w-28')}>
              <span>Language</span>
              <input
                id="upload-language"
                type="text"
                value={uploadLanguage}
                onChange={(e) => setUploadLanguage(e.target.value)}
                disabled={uploadBusy}
                maxLength={10}
                className={inputClasses}
              />
            </label>
            <label htmlFor="upload-quality" className={cn(labelClasses, 'w-28')}>
              <span>Quality</span>
              <input
                id="upload-quality"
                type="text"
                value={uploadQuality}
                onChange={(e) => setUploadQuality(e.target.value)}
                disabled={uploadBusy}
                maxLength={20}
                className={inputClasses}
              />
            </label>
            <Button type="submit" disabled={uploadBusy || !file}>
              {phase === 'ticketing'
                ? 'Preparing…'
                : phase === 'uploading'
                  ? `Uploading ${progress}%`
                  : phase === 'confirming'
                    ? 'Verifying…'
                    : 'Upload'}
            </Button>
          </div>

          {/* Progress + phase live region */}
          {uploadBusy || phase === 'done' ? (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase === 'uploading' ? progress : phase === 'done' ? 100 : undefined}
                aria-label="Upload progress"
                className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
              >
                <div
                  className={cn(
                    'h-full rounded-full bg-primary transition-[width] duration-200',
                    phase === 'uploading' ? '' : 'w-full animate-pulse',
                  )}
                  style={phase === 'uploading' ? { width: `${progress}%` } : undefined}
                />
              </div>
              <p className="text-xs text-content-muted">{phaseLabel[phase]}</p>
            </div>
          ) : null}

          {uploadError ? (
            <p role="alert" className="text-xs text-danger">
              {uploadError}
            </p>
          ) : null}
        </form>
      </section>

      {/* Remote source form ------------------------------------------------- */}
      <section
        aria-labelledby="remote-heading"
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface/50 p-4 shadow-soft"
      >
        <div className="flex flex-col gap-1">
          <h2 id="remote-heading" className="text-sm font-semibold">
            Add a remote stream
          </h2>
          <p className="text-xs text-content-muted">
            Point Lumora at a licensed https stream (HLS/DASH manifest or direct MP4). Private and localhost URLs are
            rejected.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            addRemote();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor="remote-url" className={cn(labelClasses, 'min-w-64 flex-1')}>
              <span>Stream URL (https)</span>
              <input
                id="remote-url"
                type="url"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                disabled={remotePending}
                maxLength={2048}
                placeholder="https://cdn.example.com/master.m3u8"
                className={inputClasses}
                required
              />
            </label>
            <label htmlFor="remote-kind" className={cn(labelClasses, 'w-40')}>
              <span>Kind</span>
              <select
                id="remote-kind"
                value={remoteKind}
                onChange={(e) => setRemoteKind(e.target.value as (typeof REMOTE_KIND_OPTIONS)[number])}
                disabled={remotePending}
                className={inputClasses}
              >
                {REMOTE_KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === 'auto' ? 'Auto-detect' : kind.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor="remote-label" className={cn(labelClasses, 'w-64')}>
              <span>Label</span>
              <input
                id="remote-label"
                type="text"
                value={remoteLabel}
                onChange={(e) => setRemoteLabel(e.target.value)}
                disabled={remotePending}
                maxLength={120}
                placeholder="e.g. Provider A · 1080p"
                className={inputClasses}
              />
            </label>

            {episodes.length > 0 ? (
              <>
                <label htmlFor="remote-season" className={cn(labelClasses, 'w-24')}>
                  <span>Season</span>
                  <input
                    id="remote-season"
                    type="number"
                    min={1}
                    value={remoteSeason}
                    onChange={(e) => setRemoteSeason(e.target.value)}
                    disabled={remotePending}
                    placeholder="S"
                    className={inputClasses}
                  />
                </label>
                <label htmlFor="remote-episode" className={cn(labelClasses, 'w-24')}>
                  <span>Episode</span>
                  <input
                    id="remote-episode"
                    type="number"
                    min={1}
                    value={remoteEpisode}
                    onChange={(e) => setRemoteEpisode(e.target.value)}
                    disabled={remotePending}
                    placeholder="E"
                    className={inputClasses}
                  />
                </label>
              </>
            ) : null}

            <Button type="submit" disabled={remotePending || !remoteUrl.trim()}>
              {remotePending ? 'Adding…' : 'Add source'}
            </Button>
          </div>

          {episodes.length > 0 ? (
            <p className="text-xs text-content-subtle">
              Leave season and episode blank to attach the stream to the whole title.
            </p>
          ) : null}

          {remoteError ? (
            <p role="alert" className="text-xs text-danger">
              {remoteError}
            </p>
          ) : null}
        </form>
      </section>
    </div>
  );
}
