'use client';

import { useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Import wizard shell (Section 10 "Imports" — CSV/JSON, preview, mapping,
 * validation, dry run). UI only: no file is parsed or uploaded. Demonstrates
 * the dropzone, field mapping, and dry-run summary surfaces and their states.
 */

const STEPS = ['Upload', 'Map fields', 'Dry run'] as const;

const SOURCE_COLUMNS: { column: string; sample: string }[] = [
  { column: 'title', sample: 'Aurora Drift' },
  { column: 'kind', sample: 'movie' },
  { column: 'tmdb_id', sample: '693134' },
  { column: 'year', sample: '2024' },
  { column: 'maturity', sample: 'PG-13' },
  { column: 'genres', sample: 'Sci-Fi|Thriller' },
];

const LUMORA_FIELDS = ['name', 'type', 'tmdbId', 'releaseYear', 'maturity', 'genres', '— ignore —'];

function DryRunStat({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const toneText =
    tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-content';
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <p className="text-xs text-content-muted">{label}</p>
      <p className={cn('mt-1 font-display text-2xl font-bold tabular-nums', toneText)}>{value.toLocaleString()}</p>
    </div>
  );
}

export function ImportWizard() {
  const [step, setStep] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [duplicatePolicy, setDuplicatePolicy] = useState('skip');
  const inputRef = useRef<HTMLInputElement>(null);
  const dropId = useId();

  function acceptFile(name: string | undefined) {
    setFileName(name ?? 'catalog-batch.csv');
    setStep(1);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Stepper */}
      <ol className="flex flex-wrap gap-2" aria-label="Import steps">
        {STEPS.map((label, index) => {
          const state = index === step ? 'current' : index < step ? 'done' : 'todo';
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                  state === 'current' && 'border-primary/50 bg-primary/10 text-content',
                  state === 'done' && 'border-success/40 bg-success/10 text-success',
                  state === 'todo' && 'border-border bg-surface text-content-subtle',
                )}
              >
                <span aria-hidden="true" className="tabular-nums">
                  {state === 'done' ? '✓' : index + 1}
                </span>
                {label}
              </span>
              {index < STEPS.length - 1 ? <span aria-hidden="true" className="text-content-subtle">→</span> : null}
            </li>
          );
        })}
      </ol>

      {/* Step 1: Upload */}
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              acceptFile(e.dataTransfer.files?.[0]?.name);
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border bg-surface/40',
            )}
          >
            <span aria-hidden="true" className="text-3xl text-content-subtle">
              ⇪
            </span>
            <p className="text-sm text-content">Drag a CSV or JSON file here</p>
            <p className="text-xs text-content-subtle">Up to 10 MB · UTF-8 · header row required</p>
            <label htmlFor={dropId} className="sr-only">
              Choose an import file
            </label>
            <input
              ref={inputRef}
              id={dropId}
              type="file"
              accept=".csv,.json"
              className="sr-only"
              onChange={(e) => acceptFile(e.target.files?.[0]?.name)}
            />
            <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
              Browse files
            </Button>
          </div>
          <p className="text-xs text-content-subtle">
            Imports are idempotent and resumable; a dry run is required before any publish (Section 10).
          </p>
        </div>
      ) : null}

      {/* Step 2: Map fields */}
      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-sm text-content-muted">
            <Badge tone="info">File</Badge>
            <span className="font-mono text-content">{fileName}</span>
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Map source columns to Lumora catalog fields</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Source column
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Sample
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Maps to
                  </th>
                </tr>
              </thead>
              <tbody>
                {SOURCE_COLUMNS.map((row, index) => (
                  <tr key={row.column} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-mono text-content">
                      {row.column}
                    </th>
                    <td className="px-3 py-2.5 text-content-subtle">{row.sample}</td>
                    <td className="px-3 py-2.5">
                      <label htmlFor={`map-${row.column}`} className="sr-only">
                        Map {row.column} to a Lumora field
                      </label>
                      <select
                        id={`map-${row.column}`}
                        defaultValue={LUMORA_FIELDS[index] ?? LUMORA_FIELDS[LUMORA_FIELDS.length - 1]}
                        className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-content focus-visible:outline-none"
                      >
                        {LUMORA_FIELDS.map((field) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Step 3: Dry run */}
      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DryRunStat label="Rows parsed" value={142} tone="neutral" />
            <DryRunStat label="Would create" value={128} tone="success" />
            <DryRunStat label="Would update" value={11} tone="warning" />
            <DryRunStat label="Errors" value={3} tone="danger" />
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface/50 p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="dup-policy" className="text-xs font-medium text-content-muted">
                Duplicate policy
              </label>
              <select
                id="dup-policy"
                value={duplicatePolicy}
                onChange={(e) => setDuplicatePolicy(e.target.value)}
                className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-content focus-visible:outline-none"
              >
                <option value="skip">Skip existing (by TMDB ID)</option>
                <option value="update">Update existing, protect editorial fields</option>
                <option value="error">Fail on duplicate</option>
              </select>
            </div>
            <p className="text-xs text-content-subtle">Editorial overrides are never silently overwritten (Section 10 TMDB).</p>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-content">Error sample</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              <li className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-content-muted">
                <span className="font-mono text-xs text-danger">row 44</span> — missing required field <code>tmdb_id</code>
              </li>
              <li className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-content-muted">
                <span className="font-mono text-xs text-danger">row 91</span> — invalid maturity <code>“XX”</code>
              </li>
              <li className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-content-muted">
                <span className="font-mono text-xs text-danger">row 118</span> — duplicate slug <code>aurora-drift</code>
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      {/* Controls */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" size="sm" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button size="sm" disabled={step === 0 && !fileName} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
            {step === 0 ? 'Continue' : 'Run dry run'}
          </Button>
        ) : (
          <Button size="sm" disabled title="Enabled once mapping validates and RBAC is wired">
            Import (disabled in preview)
          </Button>
        )}
      </div>
    </div>
  );
}
