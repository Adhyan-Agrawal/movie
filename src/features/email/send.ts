import 'server-only';

import { publicEnv } from '@/lib/env';
import {
  createSmtpTransporter,
  readSmtpSettingsService,
} from '@/features/admin/email/mailer';
import { getEmailTemplates, renderEmailTemplate } from '@/features/admin/email/templates';

/**
 * Best-effort transactional email sends fired from user-facing server actions.
 *
 * Unlike the admin test-send actions — which run as a `settings.manage` holder
 * and surface SMTP errors to the panel UI — sends from end-user flows (signup,
 * …) must NEVER block the response or throw into the caller. A missing or
 * broken SMTP relay, a template problem, or a DB hiccup all degrade to a logged
 * warning, never a failed action. Every exported function here is async and
 * resolves normally even when nothing was sent.
 *
 * Templates and the SMTP relay live in `site_settings`. The relay is read here
 * with the SERVICE-ROLE client (`readSmtpSettingsService`), NOT the admin RLS
 * read: the recipient of a welcome email is a brand-new public signup who holds
 * no `settings.manage`, so an admin-scoped read would always see "no SMTP" and
 * the email would never send. Only the send path uses that privileged read.
 */

/** Input for the signup welcome email. */
export interface SendWelcomeEmailInput {
  /** Recipient — the new account's email address. */
  email: string;
  /**
   * Personalisation name for the template greeting. Defaults to the local part
   * of `email` because the signup form has no name field yet (accounts created
   * by the auth trigger default their display_name to "Viewer").
   */
  name?: string;
  /** Primary CTA link. Defaults to the app home URL (`NEXT_PUBLIC_APP_URL`). */
  link?: string;
}

/**
 * Send the post-signup "welcome" email. Best-effort and side-effect free when
 * SMTP is unset: if no relay is configured the function returns without
 * contacting a mail server. Callers may fire this without awaiting it — it
 * never rejects.
 */
export async function sendWelcomeEmail(input: SendWelcomeEmailInput): Promise<void> {
  try {
    const to = input.email.trim();
    if (!to) return;

    // Check the relay first: when SMTP isn't configured (the common case) there
    // is nothing to send, and skipping the template read keeps the no-op cheap.
    const settings = await readSmtpSettingsService();
    if (!settings) {
      console.warn('[email] welcome: SMTP not configured, skipping welcome email');
      return;
    }
    const transporter = createSmtpTransporter(settings);

    const link = (input.link ?? '').trim() || publicEnv.NEXT_PUBLIC_APP_URL;
    const localPart = to.split('@')[0]?.trim();
    const name = (input.name ?? '').trim() || (localPart ? localPart : 'there');

    const templates = await getEmailTemplates();
    const tpl = templates.welcome;
    if (!tpl) {
      console.warn('[email] welcome: welcome template not found, skipping');
      return;
    }
    const rendered = renderEmailTemplate(tpl, { name, link });

    await transporter.sendMail({
      from: settings.from,
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    console.warn(`[email] welcome: sent to ${to}`);
  } catch (err) {
    // Never surface email failures to the signup flow. The SMTP password is
    // never included in what we log (nodemailer messages reference host/user).
    console.warn('[email] sendWelcomeEmail failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
