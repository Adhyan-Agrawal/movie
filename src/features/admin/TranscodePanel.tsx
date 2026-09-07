'use client';

import { useActionState, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { Title } from '@/features/catalog/types';
import { confirmUploadedSourceAction, createUploadTicketAction } from './sources-actions';
import { TRANSCODE_INITIAL_STATE, type TranscodeActionState } from './transcode-state';
import { transcodeUploadAction } from './transcode-actions';
import type { TranscodeCandidate } from './types';

/**
 * Admin HLS transcode panel (Spec Sections 7, 9). Two ways to pick the file the
 * ladder is built from:
 *  1. an EXISTING upload from private storage (any storage-backed media source),
 *  2. a NEW upload — the browser PUTs the bytes straight to a signed upload URL
 *     in the private `media` bucket (same flow as the SourcesManager), so video
 *     bytes never pass through the app server.
 *
 * The form submits the effective `titleId` / `episodeId` / storage `path` to
 * `transcodeUploadAction`, which is permission-gated server-side and streams
 * ffmpeg progress to the server log. Only the final result returns here —
 * server actions cannot stream mid-execution, so the pending state is the
 * honest "this takes minutes" spinner.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

const inputClasses =
  'h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none';

const labelClasses = 'flex flex-col gap-1.5 text-xs text-content-muted';

export function TranscodePanel({
  candidates,
  recentTitles,
}: {
  candidates: TranscodeCandidate[];
  recentTitles: Title[];
}) {
  const [state, formAction, pending] = useActionState<TranscodeActionState, FormData>(
    transcodeUploadAction,
    TRANSCODE_INITIAL_STATE,
  );

  // The effective source the form will transcode (set by either section).
  const [titleId, setTitleId] = useState('');
  const [episodeId, setEpisodeId] = useState('');
  const [path, setPath] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [label, setLabel] = useState('');

  // Existing-upload picker (values are media_sources `reference`s).
  const [sourceRef, setSourceRef] = useState('');

  // New-upload flow.
  const [uploadTitleId, setUploadTitleId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /** Candidates grouped by title for the picker's <optgroup>s. */
  const grouped = useMemo(() => {
    const byTitle = new Map<string, { titleId: string; titleName: string; candidates: TranscodeCandidate[] }>();
    for (const c of candidates) {
      const group = byTitle.get(c.titleId) ?? { titleId: c.titleId, titleName: c.titleName, candidates: [] };
      group.candidates.push(c);
      byTitle.set(c.titleId, group);
    }
    return [...byTitle.values()].sort((a, b) => a.titleName.localeCompare(b.titleName));
  }, [candidates]);

  function selectCandidate(ref: string) {
    setSourceRef(ref);
    const found = candidates.find((c) => c.reference === ref);
    if (!found) {
      setPath('');
      return;
    }
    setTitleId(found.titleId);
    setEpisodeId(found.episodeId ?? '');
    setPath(found.reference);
    setSourceLabel(`${found.titleName} · ${found.label || found.kind}`);
  }

  /** PUT the file bytes to a signed upload URL, tracking progress via XHR. */
  function putToSignedUrl(uploadUrl: string, payload: File): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', payload.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolvePromise();
        else reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — the network connection was interrupted.'));
      xhr.onabort = () => reject(new Error('Upload cancelled.'));
      xhr.send(payload);
    });
  }

  async function uploadNewFile() {
    if (!uploadTitleId) {
      setUploadError('Choose a title for the new file first.');
      return;
    }
    if (!file) {
      setUploadError('Choose a video file to upload.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('That file is larger than the 10 GB upload limit.');
      return;
    }

    setUploadError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      const ticket = await createUploadTicketAction({
        titleId: uploadTitleId,
        filename: file.name,
        contentType: file.type || undefined,
      });
      if (!ticket.ok || !ticket.path || !ticket.uploadUrl) {
        throw new Error(ticket.error ?? 'Could not create the upload ticket.');
      }

      await putToSignedUrl(ticket.uploadUrl, file);

      const confirmed = await confirmUploadedSourceAction({
        titleId: uploadTitleId,
        path: ticket.path,
        label: label || file.name,
        language: 'en',
        quality: 'auto',
      });
      if (!confirmed.ok) throw new Error(confirmed.error ?? 'Could not register the uploaded file.');

      // Point the transcode form at the just-uploaded file (title-level slot).
      const title = recentTitles.find((t) => t.id === uploadTitleId);
      setTitleId(uploadTitleId);
      setEpisodeId('');
      setPath(ticket.path);
      setSourceLabel(`${title?.name ?? uploadTitleId} · ${file.name}`);
      setSourceRef('');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 className="text-lg font-semibold text-content">HLS transcode</h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Turn an uploaded file in private storage into an adaptive HLS ladder — 1080p / 720p / 480p plus a master
          playlist — stored back in the same private bucket and registered as a native source with a quality selector.
        </p>
      </div>

      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <input type="hidden" name="titleId" value={titleId} />
        <input type="hidden" name="episodeId" value={episodeId} />
        <input type="hidden" name="path" value={path} />

        {/* Existing upload ------------------------------------------------- */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Transcode an existing upload</h3>
            <p className="text-xs text-content-muted">
              Files uploaded on the Media page appear here, one option per storage-backed source.
            </p>
          </div>
          <label htmlFor="transcode-source" className={labelClasses}>
            <span>Uploaded file</span>
            <select
              id="transcode-source"
              value={sourceRef}
              onChange={(e) => selectCandidate(e.target.value)}
              disabled={pending}
              className={inputClasses}
            >
              <option value="">— Choose a file —</option>
              {grouped.map((group) => (
                <optgroup key={group.titleId} label={group.titleName}>
                  {group.candidates.map((c) => (
                    <option key={c.sourceId} value={c.reference}>
                      {c.episodeId ? 'Episode' : 'Title'} · {c.label || c.kind} · {c.reference.split('/').pop()}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </section>

        {/* New upload ------------------------------------------------------- */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">…or upload a new file first</h3>
            <p className="text-xs text-content-muted">
              The browser PUTs the file straight to private storage (it never passes through this server), then it is
              transcoded below. For series episodes, upload via the Media page first — the file then appears in the list
              above.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor="transcode-upload-title" className={cn(labelClasses, 'min-w-56 flex-1')}>
              <span>Title</span>
              <select
                id="transcode-upload-title"
                value={uploadTitleId}
                onChange={(e) => setUploadTitleId(e.target.value)}
                disabled={uploading}
                className={inputClasses}
              >
                <option value="">— Choose a title —</option>
                {recentTitles.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.type}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="transcode-upload-file" className={cn(labelClasses, 'min-w-56 flex-1')}>
              <span>Video file</span>
              <input
                id="transcode-upload-file"
                type="file"
                accept="video/*,.m3u8,.mpd"
                disabled={uploading}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-content file:mr-3 file:rounded-sm file:border-0 file:bg-primary/15 file:px-2 file:py-1 file:text-xs file:font-medium file:text-primary focus-visible:outline-none focus-visible:border-primary"
              />
            </label>
            <Button type="button" variant="secondary" disabled={uploading || !file} onClick={uploadNewFile}>
              {uploading ? `Uploading ${uploadProgress}%` : 'Upload file'}
            </Button>
          </div>
          {uploading ? (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploadProgress}
              className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          ) : null}
          {uploadError ? (
            <p role="alert" className="text-xs text-danger">
              {uploadError}
            </p>
          ) : null}
        </section>

        {/* Transcode -------------------------------------------------------- */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Transcode</h3>
            <p className="text-xs text-content-muted">
              {path ? `Will transcode: ${sourceLabel}.` : 'Choose an uploaded file above first.'} Runs server-side with
              ffmpeg — long films take a while.
            </p>
          </div>
          <label htmlFor="transcode-label" className={labelClasses}>
            <span>Source label (optional)</span>
            <input
              id="transcode-label"
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              disabled={pending}
              placeholder="e.g. HLS ladder"
              className={inputClasses}
            />
          </label>
          <div>
            <Button type="submit" disabled={pending || !path}>
              {pending ? 'Transcoding… this can take several minutes' : 'Transcode to HLS'}
            </Button>
          </div>
        </section>

        {state.status === 'ok' ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"
          >
            <span className="font-semibold">{state.message}</span>
            {state.masterPath ? (
              <span className="break-all text-success/90">{state.renditions?.length ?? 0} renditions · {state.masterPath}</span>
            ) : null}
          </div>
        ) : null}

        {state.status === 'error' ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger"
          >
            {state.message}
          </p>
        ) : null}
      </form>
    </div>
  );
}
