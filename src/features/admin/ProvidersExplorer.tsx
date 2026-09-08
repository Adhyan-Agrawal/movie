'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { listProviderConfigs, type ProviderConfig } from '@/lib/providers/config';
import { dbProviderRowToConfig, type ProviderDbRow } from '@/lib/providers/db-providers';
import type { HealthResult, HealthStatus } from '@/lib/providers/types';
import type { Json, SourceHealthEnum } from '@/lib/supabase/types';
import type { AdminProviderRow } from './types';
import {
  runProviderHealthAction,
  saveProviderAction,
  setProviderEnabledAction,
  type ProviderSaveInput,
} from './provider-actions';

/**
 * Providers explorer (Spec Section 9). Two honest sources:
 *
 *  1. Database providers — real `providers` rows (provider.manage).
 *  2. Built-in providers — configured in application code
 *     (`src/lib/providers/config.ts`). A built-in becomes a normal database row
 *     the first time it is toggled, health-checked, or edited; once that row
 *     exists it OVERRIDES the code defaults for playback (the registry merges DB
 *     rows over built-ins — see registry.ts), and the card below shows those
 *     effective values.
 *
 * This screen also lets an operator ADD their own IFRAME embed provider and
 * EDIT the DB-backed fields of any provider (name, base URL, allowlisted
 * domains, the four path templates, priority, consent/enablement, preferred id,
 * and resume param). Edits write through `saveProviderAction`, which upserts the
 * `providers` row by key; the running registry is refreshed so the change takes
 * effect for viewers immediately.
 */

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-content">{children}</dd>
    </div>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <code key={v} className="rounded-sm border border-border bg-surface-raised/60 px-1.5 py-0.5 font-mono text-xs">
          {v}
        </code>
      ))}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function healthStatusTone(status: HealthStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unavailable':
      return 'danger';
    default:
      // 'disabled' | 'unknown'
      return 'neutral';
  }
}

function storedHealthTone(health: SourceHealthEnum): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (health) {
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'down':
      return 'danger';
    default:
      // 'unknown'
      return 'neutral';
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Editor form
// ---------------------------------------------------------------------------

const inputClasses =
  'h-10 w-full rounded-md border border-border bg-surface-raised px-3 font-mono text-sm text-content ' +
  'placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary';
const checkboxClasses = 'h-4 w-4 accent-primary';
const fieldLabelClasses = 'text-sm font-medium text-content';

/** A comma/whitespace separated list from the allowed-domains text input. */
function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read `preferred_id` / `start_param` out of a providers `config` jsonb. */
function configMeta(config: Json | null | undefined): { preferred_id?: string; start_param?: string } {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const record = config as Record<string, unknown>;
    return {
      preferred_id: typeof record.preferred_id === 'string' ? record.preferred_id : undefined,
      start_param: typeof record.start_param === 'string' ? record.start_param : undefined,
    };
  }
  return {};
}

interface ProviderFormValues {
  key: string;
  name: string;
  baseUrl: string;
  allowedDomainsText: string;
  moviePathTemplate: string;
  tvSeriesPathTemplate: string;
  episodePathTemplate: string;
  shorthandEpisodeTemplate: string;
  priority: number;
  consentRequired: boolean;
  enabled: boolean;
  preferredId: 'imdb' | 'tmdb' | '';
  startParam: string;
}

/**
 * Prefill the editor for a provider. A DB row's non-null values win; anything
 * the row leaves null falls back to the built-in code config — the same
 * override semantics the registry applies server-side.
 */
function formValuesFor(
  key: string,
  config: ProviderConfig | undefined,
  row: AdminProviderRow | undefined,
): ProviderFormValues {
  const base = config;
  const meta = configMeta(row?.config);
  return {
    key,
    name: row?.name ?? base?.displayName ?? '',
    baseUrl: row?.base_url ?? base?.baseUrl ?? '',
    allowedDomainsText: (row && row.allowed_domains.length > 0 ? row.allowed_domains : base?.allowedDomains ?? []).join(
      ', ',
    ),
    moviePathTemplate: row?.movie_path_template ?? base?.moviePathTemplate ?? '',
    tvSeriesPathTemplate: row?.series_path_template ?? base?.tvSeriesPathTemplate ?? '',
    episodePathTemplate: row?.episode_path_template ?? base?.episodePathTemplate ?? '',
    shorthandEpisodeTemplate: row?.shorthand_episode_template ?? base?.shorthandEpisodeTemplate ?? '',
    priority: row?.priority ?? base?.defaultPriority ?? 100,
    consentRequired: row?.consent_required ?? base?.consentRequired ?? false,
    enabled: row?.enabled ?? base?.enabled ?? true,
    preferredId: (meta.preferred_id ?? base?.preferredId ?? '') as 'imdb' | 'tmdb' | '',
    startParam: meta.start_param ?? base?.startParam ?? '',
  };
}

function emptyFormValues(): ProviderFormValues {
  return {
    key: '',
    name: '',
    baseUrl: '',
    allowedDomainsText: '',
    moviePathTemplate: '',
    tvSeriesPathTemplate: '',
    episodePathTemplate: '',
    shorthandEpisodeTemplate: '',
    priority: 100,
    consentRequired: true,
    enabled: true,
    preferredId: '',
    startParam: '',
  };
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={fieldLabelClasses}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * Collapsible provider editor: fields for every DB-backed editable column, bound
 * to `saveProviderAction`. Uncontrolled inputs + a submit handler that reads the
 * form keeps the code small; each editor instance is mounted fresh (conditional
 * render keyed by provider) so `defaultValue` initialization is always correct.
 */
function ProviderEditor({
  initial,
  isNew = false,
  submitLabel,
  hint,
  onDone,
}: {
  initial: ProviderFormValues;
  isNew?: boolean;
  submitLabel: string;
  hint?: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const priority = Number(fd.get('priority'));
    const rawPreferred = String(fd.get('preferred_id') ?? '');
    const input: ProviderSaveInput = {
      // The key input is editable for new providers and a hidden field otherwise,
      // so reading it from the form covers both cases.
      key: String(fd.get('key') ?? '').trim(),
      name: String(fd.get('name') ?? ''),
      baseUrl: String(fd.get('base_url') ?? ''),
      allowedDomains: splitList(String(fd.get('allowed_domains') ?? '')),
      moviePathTemplate: String(fd.get('movie_path_template') ?? ''),
      tvSeriesPathTemplate: String(fd.get('series_path_template') ?? ''),
      episodePathTemplate: String(fd.get('episode_path_template') ?? ''),
      shorthandEpisodeTemplate: String(fd.get('shorthand_episode_template') ?? ''),
      priority: Number.isFinite(priority) ? priority : 100,
      consentRequired: fd.get('consent_required') === 'on',
      enabled: fd.get('enabled') === 'on',
      preferredId: rawPreferred === 'imdb' || rawPreferred === 'tmdb' ? rawPreferred : '',
      startParam: String(fd.get('start_param') ?? ''),
    };

    setError(null);
    startTransition(async () => {
      const res = await saveProviderAction(input);
      if (!res.ok) {
        setError(res.error ?? 'Could not save the provider.');
      } else {
        router.refresh();
        onDone();
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised/40 p-4">
      {hint ? <p className="text-xs leading-relaxed text-content-muted">{hint}</p> : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {isNew ? (
          <Field id={`${initial.key || 'new'}-key`} label="Provider key" hint="Stable registry id (e.g. myprov). Lowercase letters, digits, '.', '_', '-'.">
            <input
              id={`${initial.key || 'new'}-key`}
              name="key"
              type="text"
              required
              defaultValue={initial.key}
              placeholder="myprovider"
              autoComplete="off"
              className={inputClasses}
            />
          </Field>
        ) : (
          <Field id={`${initial.key}-key`} label="Provider key" hint="The registry id is fixed once a provider exists.">
            <input id={`${initial.key}-key`} name="key" type="hidden" value={initial.key} readOnly />
            <code className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-content-muted">
              {initial.key}
            </code>
          </Field>
        )}

        <Field id={`${initial.key}-name`} label="Display name">
          <input
            id={`${initial.key}-name`}
            name="name"
            type="text"
            required
            defaultValue={initial.name}
            placeholder="My Provider"
            autoComplete="off"
            className={inputClasses.replace('font-mono', '')}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field id={`${initial.key}-base_url`} label="Base URL" hint="Origin of the embed host, e.g. https://embed.example.com.">
          <input
            id={`${initial.key}-base_url`}
            name="base_url"
            type="url"
            required
            defaultValue={initial.baseUrl}
            placeholder="https://embed.example.com"
            autoComplete="off"
            className={inputClasses}
          />
        </Field>

        <Field
          id={`${initial.key}-allowed_domains`}
          label="Allowed domains"
                   hint="Comma-separated hosts the constructed URL may resolve to. Blank uses the Base URL host."
        >
          <input
            id={`${initial.key}-allowed_domains`}
            name="allowed_domains"
            type="text"
            defaultValue={initial.allowedDomainsText}
            placeholder="embed.example.com, cdn.example.com"
            autoComplete="off"
            className={inputClasses.replace('font-mono', '')}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Field
          id={`${initial.key}-movie_path_template`}
          label="Movie path template"
          hint="Movie embeds. Placeholders: {id}."
        >
          <input
            id={`${initial.key}-movie_path_template`}
            name="movie_path_template"
            type="text"
            required
            defaultValue={initial.moviePathTemplate}
            placeholder="/embed/movie/{id}"
            autoComplete="off"
            className={inputClasses}
          />
        </Field>

        <Field
          id={`${initial.key}-series_path_template`}
          label="TV-series path template"
          hint="Whole-series route for the provider's built-in picker. Placeholders: {id}."
        >
          <input
            id={`${initial.key}-series_path_template`}
            name="series_path_template"
            type="text"
            required
            defaultValue={initial.tvSeriesPathTemplate}
            placeholder="/embed/tv/{id}"
            autoComplete="off"
            className={inputClasses}
          />
        </Field>

        <Field
          id={`${initial.key}-episode_path_template`}
          label="Episode path template"
          hint="A specific episode. Placeholders: {id}, {season}, {episode}."
        >
          <input
            id={`${initial.key}-episode_path_template`}
            name="episode_path_template"
            type="text"
            required
            defaultValue={initial.episodePathTemplate}
            placeholder="/embed/tv/{id}/{season}/{episode}"
            autoComplete="off"
            className={inputClasses}
          />
        </Field>

        <Field
          id={`${initial.key}-shorthand_episode_template`}
          label="Shorthand episode template"
          hint="Optional shorthand episode route. Placeholders: {id}, {season}, {episode}."
        >
          <input
            id={`${initial.key}-shorthand_episode_template`}
            name="shorthand_episode_template"
            type="text"
            required
            defaultValue={initial.shorthandEpisodeTemplate}
            placeholder="/embed/tv/{id}-{season}-{episode}"
            autoComplete="off"
            className={inputClasses}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field id={`${initial.key}-priority`} label="Priority" hint="Higher runs first as Server N.">
          <input
            id={`${initial.key}-priority`}
            name="priority"
            type="number"
            required
            min={0}
            step={1}
            defaultValue={initial.priority}
            className={inputClasses.replace('font-mono', '')}
          />
        </Field>

        <Field
          id={`${initial.key}-preferred_id`}
          label="Preferred media id"
                   hint="Which external id the provider resolves best: IMDb (tt…), TMDB (digits), or blank for default."
        >
          <select
            id={`${initial.key}-preferred_id`}
            name="preferred_id"
            defaultValue={initial.preferredId}
            className={inputClasses.replace('font-mono', '')}
          >
            <option value="">Default</option>
            <option value="imdb">IMDb (tt…)</option>
            <option value="tmdb">TMDB (digits)</option>
          </select>
        </Field>

        <Field
          id={`${initial.key}-start_param`}
          label="Resume param"
                   hint="Query param the embed accepts for a start position (e.g. startAt). Blank = not supported."
        >
          <input
            id={`${initial.key}-start_param`}
            name="start_param"
            type="text"
            defaultValue={initial.startParam}
            placeholder="startAt"
            autoComplete="off"
            className={inputClasses.replace('font-mono', '')}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-content">
          <input name="enabled" type="checkbox" defaultChecked={initial.enabled} className={checkboxClasses} />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            name="consent_required"
            type="checkbox"
            defaultChecked={initial.consentRequired}
            className={checkboxClasses}
          />
          Consent required before loading the external iframe
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="md" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Enable/disable + health + edit actions
// ---------------------------------------------------------------------------

/** Enable/disable + on-demand health probe for one provider. */
function ProviderActions({ providerKey, enabled }: { providerKey: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HealthResult | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const res = await setProviderEnabledAction(providerKey, !enabled);
      if (!res.ok) setError(res.error ?? 'Could not update the provider.');
      else router.refresh();
    });
  }

  function runHealth() {
    setError(null);
    startTransition(async () => {
      const res = await runProviderHealthAction(providerKey);
      if (!res.ok) setError(res.error ?? 'Could not run the health check.');
      else if (res.result) setResult(res.result);
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="secondary" disabled={pending} onClick={toggle}>
          {enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={runHealth}>
          {pending ? 'Checking…' : 'Run health check'}
        </Button>
      </div>
      {result ? (
        <span className="flex flex-wrap items-center gap-1 text-xs text-content-muted">
          <Badge tone={healthStatusTone(result.status)}>{result.status}</Badge>
          <span>
            {result.latencyMs != null ? `${result.latencyMs} ms` : 'no latency'} · {formatTime(result.checkedAt)}
          </span>
          {result.detail ? <span>· {result.detail}</span> : null}
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BuiltinProviderCard({
  config,
  dbRow,
  editing,
  onEdit,
  onCloseEditor,
}: {
  config: ProviderConfig;
  dbRow?: AdminProviderRow;
  editing: boolean;
  onEdit: () => void;
  onCloseEditor: () => void;
}) {
  // When a DB row exists for this built-in key it OVERRIDES the code defaults
  // for playback (registry merge). Reflect those effective values so the card
  // says what the server will actually use, and let edits write to the row.
  const effective = dbRow ? dbProviderRowToConfig(dbRow as ProviderDbRow, config) : config;
  const display = effective ?? config;
  const enabled = dbRow?.enabled ?? display.enabled;
  const rowBacked = Boolean(dbRow);

  return (
    <section
      aria-labelledby={`builtin-${config.id}`}
      className="rounded-lg border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h3 id={`builtin-${config.id}`} className="font-display text-lg font-semibold">
            {display.displayName}
          </h3>
          <p className="mt-1 text-xs text-content-subtle">
            {rowBacked ? (
              <>
                Built-in provider <span className="text-content-muted">(configured in code)</span> — a database row
                overrides these values for playback. Edits below write to the <code className="font-mono">providers</code>{' '}
                row.
              </>
            ) : (
              <>
                Built-in provider — configured in code. Use <strong>Customize</strong> to create a database row that
                overrides these values for playback (the first toggle or health check also creates one).
              </>
            )}
          </p>
        </div>
        <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
      </div>

      <dl className="divide-y divide-border">
        <DetailRow label="Display name">{display.displayName}</DetailRow>
        <DetailRow label="Base URL">
          <code className="font-mono text-sm">{display.baseUrl}</code>
          <span className="ml-2 text-xs text-content-subtle">({hostOf(display.baseUrl)})</span>
        </DetailRow>
        <DetailRow label="Allowed domains">
          <Chips values={display.allowedDomains} />
        </DetailRow>
        <DetailRow label="Movie path">
          <code className="font-mono text-sm">{display.moviePathTemplate}</code>
        </DetailRow>
        <DetailRow label="TV-series path">
          <code className="font-mono text-sm">{display.tvSeriesPathTemplate}</code>
        </DetailRow>
        <DetailRow label="Episode path">
          <code className="font-mono text-sm">{display.episodePathTemplate}</code>
        </DetailRow>
        <DetailRow label="Shorthand episode">
          <code className="font-mono text-sm">{display.shorthandEpisodeTemplate}</code>
        </DetailRow>
        <DetailRow label="Priority">{display.defaultPriority}</DetailRow>
        <DetailRow label="Timeout">{display.timeoutMs} ms</DetailRow>
        <DetailRow label="Regions">
          <Chips values={display.enabledRegions} />
        </DetailRow>
        <DetailRow label="Consent required">
          <Badge tone={display.consentRequired ? 'info' : 'neutral'}>{display.consentRequired ? 'Yes' : 'No'}</Badge>
        </DetailRow>
        <DetailRow label="Preferred id">
          {display.preferredId ? (
            <code className="font-mono text-sm">{display.preferredId}</code>
          ) : (
            <span className="text-content-muted">Default</span>
          )}
        </DetailRow>
        <DetailRow label="Resume param">
          {display.startParam ? (
            <code className="font-mono text-sm">{display.startParam}</code>
          ) : (
            <span className="text-content-muted">Not supported</span>
          )}
        </DetailRow>
        <DetailRow label="Test title ID">
          <code className="font-mono text-sm">{display.testTitleId}</code>
        </DetailRow>
      </dl>

      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
        <ProviderActions providerKey={config.id} enabled={enabled} />
        <div>
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {editing ? 'Close editor' : rowBacked ? 'Edit' : 'Customize'}
          </Button>
        </div>
        {editing ? (
          <ProviderEditor
            initial={formValuesFor(config.id, config, dbRow)}
            submitLabel={rowBacked ? 'Save changes' : 'Create provider row'}
            hint={
              rowBacked
                ? 'Saving updates the database row that overrides this built-in for playback.'
                : 'Saving creates a database row for this provider key. It then overrides the code defaults for playback.'
            }
            onDone={onCloseEditor}
          />
        ) : null}
      </div>
    </section>
  );
}

export function ProvidersExplorer({ rows }: { rows: AdminProviderRow[] }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const builtinKeys = new Set(listProviderConfigs().map((c) => c.id));

  const closeEditor = () => setEditingKey(null);
  const toggleEditor = (key: string) => setEditingKey((current) => (current === key ? null : key));

  return (
    <div className="flex flex-col gap-8">
      {/* Add custom provider */}
      <section aria-label="Add a custom provider">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">Add a custom provider</h2>
            <p className="text-sm text-content-muted">
              Register your own IFRAME embed provider. The saved row becomes a &quot;Server N&quot; in the player
              selector, ordered by priority.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setAddOpen((open) => !open)}>
            {addOpen ? 'Hide form' : 'Add custom provider'}
          </Button>
        </div>
        {addOpen ? (
          <ProviderEditor
            initial={emptyFormValues()}
            isNew
            submitLabel="Add provider"
            hint="Match the path templates to the embed host's documented routes. {id} accepts an IMDb or TMDB id; {season}/{episode} fill specific episodes. The host must be allowlisted in the app's CSP (next.config.mjs) or the browser will refuse to frame it."
            onDone={() => setAddOpen(false)}
          />
        ) : null}
      </section>

      {/* Database-configured providers */}
      <section aria-label="Database providers">
        <h2 className="mb-3 font-display text-lg font-semibold">Configured in the database</h2>
        {rows.length === 0 ? (
          <EmptyState
            icon="⧉"
            title="No providers in the database yet"
            description="Provider rows are created the first time a built-in provider is toggled, health-checked, or customized below. Playback currently resolves through the built-in providers configured in code."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Provider rows from the providers table</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Provider
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Adapter
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Base URL
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Enabled
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Health
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Priority
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <FragmentRow
                    key={row.id}
                    row={row}
                    isCustom={!builtinKeys.has(row.key)}
                    editing={editingKey === row.key}
                    onToggleEdit={() => toggleEditor(row.key)}
                    onCloseEditor={closeEditor}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Built-in (code-configured) providers */}
      <section aria-label="Built-in providers">
        <h2 className="mb-3 font-display text-lg font-semibold">Built-in providers (configured in code)</h2>
        <div className="flex flex-col gap-4">
          {listProviderConfigs().map((config) => (
            <BuiltinProviderCard
              key={config.id}
              config={config}
              dbRow={rowByKey.get(config.id)}
              editing={editingKey === config.id}
              onEdit={() => toggleEditor(config.id)}
              onCloseEditor={closeEditor}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** One providers-table row plus its inline editor row (for custom providers). */
function FragmentRow({
  row,
  isCustom,
  editing,
  onToggleEdit,
  onCloseEditor,
}: {
  row: AdminProviderRow;
  isCustom: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onCloseEditor: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HealthResult | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const res = await setProviderEnabledAction(row.key, !row.enabled);
      if (!res.ok) setError(res.error ?? 'Could not update the provider.');
      else router.refresh();
    });
  }

  function runHealth() {
    setError(null);
    startTransition(async () => {
      const res = await runProviderHealthAction(row.key);
      if (!res.ok) setError(res.error ?? 'Could not run the health check.');
      else if (res.result) setResult(res.result);
    });
  }

  return (
    <>
      <tr className="border-b border-border/60 last:border-0">
        <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
          <span className="block font-medium text-content">{row.name}</span>
          <span className="block font-mono text-xs text-content-subtle">{row.key}</span>
        </th>
        <td className="px-3 py-2.5 font-mono text-xs text-content-muted">{row.adapter}</td>
        <td className="px-3 py-2.5">
          <code className="font-mono text-xs text-content-muted">{row.base_url ?? '—'}</code>
        </td>
        <td className="px-3 py-2.5">
          <Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Enabled' : 'Disabled'}</Badge>
        </td>
        <td className="px-3 py-2.5">
          <Badge tone={storedHealthTone(row.health)}>{row.health}</Badge>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{row.priority}</td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col items-start gap-1">
            <div className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="secondary" disabled={pending} onClick={toggle}>
                {row.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={runHealth}>
                {pending ? 'Checking…' : 'Health'}
              </Button>
              {isCustom ? (
                <Button size="sm" variant="ghost" onClick={onToggleEdit}>
                  {editing ? 'Close' : 'Edit'}
                </Button>
              ) : null}
            </div>
            {result ? (
              <span className="flex flex-wrap items-center gap-1 text-xs text-content-muted">
                <Badge tone={healthStatusTone(result.status)}>{result.status}</Badge>
                <span>{result.latencyMs != null ? `${result.latencyMs} ms` : ''}</span>
              </span>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </td>
      </tr>
      {editing && isCustom ? (
        <tr className="border-b border-border/60 last:border-0">
          <td colSpan={7} className="bg-surface-raised/30 px-3 py-3">
            <ProviderEditor
              initial={formValuesFor(row.key, undefined, row)}
              submitLabel="Save changes"
              onDone={onCloseEditor}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
