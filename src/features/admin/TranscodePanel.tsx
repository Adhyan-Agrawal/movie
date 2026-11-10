import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { TRANSCODE_OFFLINE_COMMAND } from './transcode-state';

/** The offline Node operator tool is deliberately separate from the web UI. */
export function TranscodePanel() {
  return (
    <section aria-labelledby="transcode-unavailable" className="flex max-w-2xl flex-col gap-4">
      <h2 id="transcode-unavailable" className="text-lg font-semibold text-content">
        Web transcoding unavailable on this deployment
      </h2>
      <p className="text-sm leading-relaxed text-content-muted">
        No web transcode executor is configured. Setting an ffmpeg or ffprobe path or uploading a file
        here cannot enable transcoding. No job has been queued and existing uploads are unchanged.
      </p>
      <div>
        <Button disabled aria-describedby="transcode-unavailable">Transcode to HLS unavailable</Button>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4">
        <h3 className="text-sm font-semibold">Offline operator tool</h3>
        <p className="text-sm text-content-muted">
          On an operator-controlled Node.js machine with ffmpeg and ffprobe installed, run:
        </p>
        <code className="break-words rounded-md bg-surface-raised p-3 text-sm text-content">
          {TRANSCODE_OFFLINE_COMMAND}
        </code>
        <p className="text-sm leading-relaxed text-content-muted">
          This creates local 1080p / 720p / 480p playlists and segments plus a master playlist. It does not upload
          files or register a source. Publishing the output requires a separate authorized storage and source-registration workflow.
        </p>
      </div>
      <p className="text-sm leading-relaxed text-content-muted">
        Working web transcoding requires a separately authorized executor. None is configured; this page does not
        create a queue or start a service.
      </p>
      <Link href="/admin/sources" className="text-sm text-primary underline">Manage existing media sources</Link>
    </section>
  );
}
