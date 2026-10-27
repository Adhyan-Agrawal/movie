'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DISCOVERY_LANGUAGES, normalizeCountryFilter, normalizeLanguageFilter } from '../discovery';

export function DiscoveryFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const language = normalizeLanguageFilter(searchParams.get('originalLanguage') ?? undefined) ?? '';
  const country = normalizeCountryFilter(searchParams.get('country') ?? undefined) ?? '';
  const update = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value); else params.delete(key);
    params.delete('page');
    startTransition(() => router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false }));
  };
  return (
    <section aria-label="Language and country filters" aria-busy={pending} className="discovery-filters mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface/50 p-4">
      <label className="flex flex-1 flex-col gap-1.5 sm:flex-none">
        <span className="text-xs font-medium text-content-subtle">Original language</span>
        <select value={language} onChange={(event) => update('originalLanguage', event.target.value)} className="min-h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <option value="">All languages</option>
          {language && !DISCOVERY_LANGUAGES.some((item) => item.value === language) ? <option value={language}>{language}</option> : null}
          {DISCOVERY_LANGUAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1.5 sm:flex-none">
        <span className="text-xs font-medium text-content-subtle">Country of origin</span>
        <select value={country} onChange={(event) => update('country', event.target.value)} className="min-h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <option value="">All countries</option>
          {country && !['IN', 'KR', 'JP', 'US', 'GB', 'FR', 'ES'].includes(country) ? <option value={country}>{country}</option> : null}
          <option value="IN">India (all languages)</option><option value="KR">South Korea</option><option value="JP">Japan</option>
          <option value="US">United States</option><option value="GB">United Kingdom</option><option value="FR">France</option><option value="ES">Spain</option>
        </select>
      </label>
      <p className="max-w-sm text-xs text-content-subtle">Language is not nationality. Only provider-reported metadata is used.</p>
      <span role="status" className="text-xs text-content-muted">{pending ? 'Updating titles...' : ''}</span>
    </section>
  );
}
