'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import {
  getSmtpTransporter,
  readSmtpSettings,
  SMTP_SETTING_DESCRIPTIONS,
  SMTP_SETTING_KEYS,
} from './email/mailer';
import type { EmailSettingsState } from './email-settings-state';

/**
 * Admin SMTP / email-settings actions (Spec Section 10).
 *
 * Both actions assert `settings.manage` server-side (the same key the
 * `site_settings` RLS policies enforce) BEFORE any data access, then return a
 * clean `{ status, message }` on denial — never a thrown error the client
 * can't render. Writes use the RLS-scoped server client, so every upsert runs
 * as the signed-in admin (updated_by is attributable) and is subject to the
 * same `site_settings_admin_write` policy the permission gate mirrors.
 *
 * Passwords are write-only: the panel never receives the stored value, and a
 * blank password on save means "keep the existing one". The password is never
 * logged here or in the mailer util.
 */

/** Simple but strict-enough shape for the from address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PERMISSION_ERROR = 'You need the settings.manage permission to manage email settings.';

/** Permission gate shared by every exported action. */
async function ensurePermission(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    return null;
  } catch {
    return PERMISSION_ERROR;
  }
}

/**
 * Save the SMTP relay settings as `smtp.*` rows in `site_settings` (one row
 * per value, key = primary key). Validates host/port/user/password/from first;
 * a blank password keeps the currently stored one (only an error when no
 * password exists yet).
 */
export async function saveEmailSettingsAction(
  _prev: EmailSettingsState,
  formData: FormData,
): Promise<EmailSettingsState> {
  const str = (name: string) => String(formData.get(name) ?? '').trim();

  const host = str('host');
  const portRaw = str('port');
  const user = str('user');
  const password = str('password');
  const from = str('from');

  // --- Validation, before any data access ---
  if (!host) return { status: 'error', message: 'SMTP host is required.' };
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    return { status: 'error', message: 'SMTP host contains invalid characters.' };
  }
  const port = Number.parseInt(portRaw, 10);
  if (!portRaw || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 'error', message: 'SMTP port must be a whole number between 1 and 65535.' };
  }
  if (!user) return { status: 'error', message: 'SMTP username is required.' };
  if (!EMAIL_RE.test(from)) return { status: 'error', message: 'The from address must be a valid email address.' };

  const denied = await ensurePermission();
  if (denied) return { status: 'error', message: denied };

  // A blank password means "keep the existing one" — only a problem when none
  // is stored yet (the form hints at this).
  const db = await getSupabaseServerClient();
  const { data: passRow, error: passError } = await db
    .from('site_settings')
    .select('value')
    .eq('key', SMTP_SETTING_KEYS.pass)
    .maybeSingle();
  if (passError) {
    return { status: 'error', message: `Could not load the current password: ${passError.message}` };
  }
  const existingPass = typeof passRow?.value === 'string' ? passRow.value : '';
  if (!password && !existingPass) {
    return { status: 'error', message: 'A password is required the first time SMTP is configured.' };
  }
  const pass = password || existingPass;

  const { data: userData } = await db.auth.getUser();
  const updatedBy = userData.user?.id ?? null;
  const updatedAt = new Date().toISOString();

  const values: Record<string, string | number> = {
    [SMTP_SETTING_KEYS.host]: host,
    [SMTP_SETTING_KEYS.port]: port,
    [SMTP_SETTING_KEYS.user]: user,
    [SMTP_SETTING_KEYS.pass]: pass,
    [SMTP_SETTING_KEYS.from]: from,
  };

  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    is_public: false, // credentials — never exposed by the public-read policy
    description: SMTP_SETTING_DESCRIPTIONS[key] ?? '',
    updated_by: updatedBy,
    updated_at: updatedAt,
  }));

  const { error: upsertError } = await db.from('site_settings').upsert(rows, { onConflict: 'key' });
  if (upsertError) {
    return { status: 'error', message: `Could not save email settings: ${upsertError.message}` };
  }

  revalidatePath('/admin/email');
  return { status: 'ok', message: 'Email settings saved.' };
}

/**
 * Send a test message through the stored SMTP relay to verify the config.
 * Sends to the configured `from` address (a self-test — no recipient lookup
 * needed). Reports the transport's failure verbatim so a bad host/auth is
 * diagnosable.
 */
export async function sendTestEmailAction(
  _prev: EmailSettingsState,
  _formData: FormData,
): Promise<EmailSettingsState> {
  const denied = await ensurePermission();
  if (denied) return { status: 'error', message: denied };

  try {
    const settings = await readSmtpSettings();
    if (!settings) {
      return {
        status: 'error',
        message: 'SMTP is not configured yet — save the host, port, username, password, and from address first.',
      };
    }

    const transporter = await getSmtpTransporter();
    if (!transporter) {
      return { status: 'error', message: 'SMTP is not configured yet — save all the fields above first.' };
    }

    await transporter.sendMail({
      from: settings.from,
      to: settings.from,
      subject: 'Lumora SMTP test message',
      text: [
        'This is a test email from Lumora.',
        '',
        'It was sent from the admin email settings panel to verify the SMTP relay.',
        `Relay: ${settings.host}:${settings.port}`,
        `Username: ${settings.user}`,
        `Sent at: ${new Date().toISOString()}`,
      ].join('\n'),
    });

    return { status: 'ok', message: `Test email sent to ${settings.from}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', message: `Test email failed: ${message}` };
  }
}
