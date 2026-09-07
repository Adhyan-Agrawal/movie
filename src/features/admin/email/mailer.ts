import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * SMTP mailer util (admin email settings).
 *
 * The SMTP connection lives in `site_settings` as one row per value
 * (`smtp.host` / `smtp.port` / `smtp.user` / `smtp.pass` / `smtp.from`) —
 * the same key/value jsonb table the rest of settings uses. Reads go through
 * the RLS-scoped server client, so only `settings.manage` holders can load the
 * credentials (site_settings_admin_read policy), and they stay here: the
 * password never crosses into a client bundle and is never logged.
 *
 * When SMTP is not fully configured, `readSmtpSettings` returns null and
 * `getSmtpTransporter` returns null — callers degrade gracefully instead of
 * half-sending with a broken config.
 */

/** `site_settings` keys that make up the SMTP configuration. */
export const SMTP_SETTING_KEYS = {
  host: 'smtp.host',
  port: 'smtp.port',
  user: 'smtp.user',
  pass: 'smtp.pass',
  from: 'smtp.from',
} as const;

/** The setting-key literal union (`'smtp.host' | …`). */
export type SmtpSettingKey = (typeof SMTP_SETTING_KEYS)[keyof typeof SMTP_SETTING_KEYS];

/** Human labels for each SMTP setting — written to `site_settings.description`. */
export const SMTP_SETTING_DESCRIPTIONS: Record<string, string> = {
  'smtp.host': 'SMTP server hostname',
  'smtp.port': 'SMTP server port',
  'smtp.user': 'SMTP authentication username',
  'smtp.pass': 'SMTP authentication password',
  'smtp.from': 'From address for outgoing mail',
};

/** Decoded, sendable SMTP settings read from `site_settings`. */
export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/**
 * Load the SMTP settings from `site_settings`. Returns null when any required
 * value is missing or malformed — an incomplete config counts as "no config",
 * so callers fail with a clear "configure SMTP first" message rather than a
 * cryptic transport error.
 */
export async function readSmtpSettings(): Promise<SmtpSettings | null> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('site_settings')
    .select('key, value')
    .in('key', Object.values(SMTP_SETTING_KEYS));
  if (error) throw new Error(`readSmtpSettings failed: ${error.message}`);
  if (!data || data.length === 0) return null;

  const values = new Map(data.map((row) => [row.key, row.value]));

  const host = values.get(SMTP_SETTING_KEYS.host);
  const user = values.get(SMTP_SETTING_KEYS.user);
  const pass = values.get(SMTP_SETTING_KEYS.pass);
  const from = values.get(SMTP_SETTING_KEYS.from);
  const portRaw = values.get(SMTP_SETTING_KEYS.port);

  if (typeof host !== 'string' || host.trim() === '') return null;
  if (typeof user !== 'string' || user.trim() === '') return null;
  if (typeof pass !== 'string' || pass.trim() === '') return null;
  if (typeof from !== 'string' || from.trim() === '') return null;

  const port = typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host: host.trim(), port, user: user.trim(), pass: pass.trim(), from: from.trim() };
}

/**
 * A nodemailer transporter wired to the stored SMTP config, or null when SMTP
 * is not configured (or the config is incomplete). Port 465 gets implicit TLS;
 * every other port upgrades to STARTTLS, which nodemailer does by default.
 */
export async function getSmtpTransporter(): Promise<Transporter | null> {
  const settings = await readSmtpSettings();
  if (!settings) return null;

  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: { user: settings.user, pass: settings.pass },
  });
}
