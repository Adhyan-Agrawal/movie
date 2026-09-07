'use server';

import { revalidatePath } from 'next/cache';
import { publicEnv } from '@/lib/env';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { getSmtpTransporter, readSmtpSettings } from './mailer';
import {
  defaultEmailTemplate,
  getEmailTemplates,
  isEmailTemplateId,
  renderEmailTemplate,
  saveEmailTemplates,
  type EmailTemplate,
  type EmailTemplateId,
  type EmailTemplateVars,
} from './templates';
import type { TemplateActionState } from './templates-state';

/**
 * Admin email-template actions (Spec Section 10).
 *
 * Both actions assert `settings.manage` server-side (the same key the
 * `site_settings` RLS policies enforce) BEFORE any data access, then return a
 * clean `{ status, message }` on denial — never a thrown error the client
 * can't render. Writes go through `saveEmailTemplates` (service client, gated
 * here); test sends use the SMTP relay read from `site_settings` by the mailer
 * util and report the transport's verdict verbatim so a bad host/auth is
 * diagnosable.
 */

/** Simple but strict-enough shape for the test recipient address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PERMISSION_ERROR = 'You need the settings.manage permission to manage email templates.';

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
 * Save template overrides. `templatesJson` must be a JSON object keyed by
 * known template ids, each with a non-empty `subject`, `bodyHtml`, and
 * `bodyText`. Entries identical to the built-in default are treated as
 * "revert" and cleared from the stored overrides.
 */
export async function saveEmailTemplatesAction(templatesJson: string): Promise<TemplateActionState> {
  const denied = await ensurePermission();
  if (denied) return { status: 'error', message: denied };

  let parsed: unknown;
  try {
    parsed = JSON.parse(templatesJson);
  } catch {
    return { status: 'error', message: 'The templates payload is not valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', message: 'Expected a JSON object keyed by template id.' };
  }

  const incoming = parsed as Record<string, unknown>;
  const overrides: Partial<Record<EmailTemplateId, EmailTemplate>> = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (!isEmailTemplateId(key)) {
      return { status: 'error', message: `Unknown template id "${key}".` };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'error', message: `Template "${key}" must be an object with subject, bodyHtml, and bodyText.` };
    }

    const tpl = value as Record<string, unknown>;
    const subject = typeof tpl.subject === 'string' ? tpl.subject.trim() : '';
    const bodyHtml = typeof tpl.bodyHtml === 'string' ? tpl.bodyHtml.trim() : '';
    const bodyText = typeof tpl.bodyText === 'string' ? tpl.bodyText.trim() : '';
    if (!subject || !bodyHtml || !bodyText) {
      return {
        status: 'error',
        message: `Template "${key}" needs a non-empty subject, HTML body, and text body.`,
      };
    }

    overrides[key] = {
      id: key,
      subject,
      bodyHtml,
      bodyText,
      description: defaultEmailTemplate(key).description,
    };
  }

  if (Object.keys(overrides).length === 0) {
    return { status: 'error', message: 'No template changes were provided.' };
  }

  try {
    await saveEmailTemplates(overrides);
  } catch (err) {
    return {
      status: 'error',
      message: `Could not save the template: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  revalidatePath('/admin/email/templates');
  return { status: 'ok', message: 'Template saved.' };
}

/**
 * Send a test of one template to an arbitrary address through the stored SMTP
 * relay. The template is rendered with sample variables so the admin can see
 * real-looking output without triggering a live event.
 */
export async function sendTestTemplateAction(templateId: string, toEmail: string): Promise<TemplateActionState> {
  const denied = await ensurePermission();
  if (denied) return { status: 'error', message: denied };

  if (!isEmailTemplateId(templateId)) {
    return { status: 'error', message: 'Unknown template id.' };
  }
  if (!EMAIL_RE.test(toEmail)) {
    return { status: 'error', message: 'The test recipient address is not valid.' };
  }

  try {
    const templates = await getEmailTemplates();
    const tpl = templates[templateId];
    if (!tpl) return { status: 'error', message: 'Template not found.' };

    const sampleVars: EmailTemplateVars = {
      name: 'Lumora test recipient',
      title: 'A sample title',
      link: publicEnv.NEXT_PUBLIC_APP_URL,
    };
    const rendered = renderEmailTemplate(tpl, sampleVars);

    const settings = await readSmtpSettings();
    const transporter = settings ? await getSmtpTransporter() : null;
    if (!settings || !transporter) {
      return { status: 'error', message: 'SMTP not configured — save email settings first' };
    }

    await transporter.sendMail({
      from: settings.from,
      to: toEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    return { status: 'ok', message: `Test "${tpl.id}" template sent to ${toEmail}.` };
  } catch (err) {
    return {
      status: 'error',
      message: `Test email failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
