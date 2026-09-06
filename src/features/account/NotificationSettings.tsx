'use client';

import { useState } from 'react';
import { Switch } from './Switch';
import { MOCK_NOTIFICATION_CATEGORIES, type NotificationCategory } from './mock';

type Channel = 'email' | 'push';

/**
 * Notification preference switches (Section 4). Changes apply immediately and
 * are reported through an aria-live status region, mirroring calm system-
 * settings patterns. Persistence is a no-op until the account service lands.
 */
export function NotificationSettings() {
  const [categories, setCategories] = useState<NotificationCategory[]>(MOCK_NOTIFICATION_CATEGORIES);
  const [status, setStatus] = useState('All changes are saved automatically.');

  const toggle = (id: string, channel: Channel, value: boolean) => {
    setCategories((prev) => prev.map((category) => (category.id === id ? { ...category, [channel]: value } : category)));
    setStatus('Preferences saved.');
  };

  return (
    <section aria-labelledby="notifications-heading" className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="text-sm text-content-muted">Choose how Lumora reaches you. Changes save automatically.</p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40">
        {categories.map((category) => (
          <li
            key={category.id}
            className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-0.5 sm:pr-6">
              <span className="text-sm font-medium text-content">{category.label}</span>
              <span className="text-sm text-content-muted">{category.description}</span>
            </div>
            <div className="flex items-center gap-5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-content-muted">Email</span>
                <Switch
                  checked={category.email}
                  onChange={(value) => toggle(category.id, 'email', value)}
                  label={`${category.label} — email notifications`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-content-muted">Push</span>
                <Switch
                  checked={category.push}
                  onChange={(value) => toggle(category.id, 'push', value)}
                  label={`${category.label} — push notifications`}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <p role="status" aria-live="polite" className="text-sm text-content-muted">
        {status}
      </p>
    </section>
  );
}
