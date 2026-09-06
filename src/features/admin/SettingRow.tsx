'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from './ConfirmDialog';
import type { Setting } from './mock';

/**
 * A single setting row (Section 10 — "Every setting shows scope, default,
 * validation, affected surfaces, editor, timestamp, and rollback").
 *
 * 'use client' because the rollback affordance is a reversible action that must
 * open the ConfirmDialog. Editing is a no-op preview until settings APIs exist.
 */

function formatUpdated(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 10)}`;
}

function ValuePreview({ setting, useDefault = false }: { setting: Setting; useDefault?: boolean }) {
  const raw = useDefault ? setting.defaultValue : setting.value;
  if (setting.kind === 'toggle') {
    const on = raw === 'on' || raw === 'true';
    return <Badge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>;
  }
  if (setting.kind === 'color') {
    return (
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="h-4 w-4 rounded-sm border border-border-strong" style={{ background: raw }} />
        <code className="font-mono text-sm text-content">{raw}</code>
      </span>
    );
  }
  return <code className="font-mono text-sm text-content">{raw}</code>;
}

export function SettingRow({ setting }: { setting: Setting }) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  const isDirty = setting.value !== setting.defaultValue;

  return (
    <div className="flex flex-col gap-3 border-b border-border py-4 last:border-0 md:flex-row md:items-start md:justify-between md:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-content">{setting.label}</h3>
          <Badge tone="info">{setting.scope}</Badge>
          {isDirty ? <Badge tone="warning">Overridden</Badge> : <Badge tone="neutral">Default</Badge>}
        </div>
        <code className="mt-0.5 block font-mono text-xs text-content-subtle">{setting.key}</code>
        <p className="mt-2 text-xs text-content-muted">{setting.validation}</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-content-subtle">Affects:</span>
          {setting.affectedSurfaces.map((surface) => (
            <span
              key={surface}
              className="rounded-sm border border-border bg-surface-raised/60 px-1.5 py-0.5 text-[11px] text-content-muted"
            >
              {surface}
            </span>
          ))}
        </div>

        <p className="mt-2 text-[11px] text-content-subtle">
          {`Edited by ${setting.editor} · ${formatUpdated(setting.updatedAt)}`}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-start gap-2 md:w-64 md:items-end">
        <div className="flex flex-col gap-1 md:items-end">
          <span className="text-[11px] uppercase tracking-wide text-content-subtle">Current</span>
          <ValuePreview setting={setting} />
        </div>
        <div className="flex flex-col gap-1 md:items-end">
          <span className="text-[11px] uppercase tracking-wide text-content-subtle">Default</span>
          <ValuePreview setting={setting} useDefault />
        </div>
        <div className="mt-1 flex gap-2">
          <Button size="sm" variant="secondary" aria-label={`Edit ${setting.label}`}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isDirty}
            onClick={() => setConfirmRevert(true)}
            className={cn(!isDirty && 'opacity-50')}
          >
            Roll back
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRevert}
        title={`Roll back ${setting.label}?`}
        description={
          <>
            This resets <code className="font-mono">{setting.key}</code> from{' '}
            <strong>{setting.value}</strong> to its default <strong>{setting.defaultValue}</strong>. The change is
            reversible and will be recorded in the audit log.
          </>
        }
        confirmLabel="Roll back"
        onCancel={() => setConfirmRevert(false)}
        onConfirm={() => setConfirmRevert(false)}
      />
    </div>
  );
}
