import 'server-only';

import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

/**
 * Transactional email templates (admin email settings).
 *
 * Every automated message Lumora can send has a template here: a subject, an
 * HTML body, and a plain-text body with `{{var}}` placeholders. Built-in copy
 * lives in `DEFAULT_EMAIL_TEMPLATES` so the product works out of the box;
 * admins can override any template through the admin panel, persisted as a
 * single `email.templates` JSON object in `site_settings` (internal — never
 * `is_public`). `renderEmailTemplate` replaces placeholders and returns the
 * three sendable strings.
 *
 * Reads/writes use the SERVICE client: templates are global site configuration,
 * and the user-facing flows that actually send these emails (signup, password
 * reset, …) run as the end user, where the RLS-scoped client would not see the
 * internal `email.templates` row. The permission gate lives in
 * `./templates-actions` (`settings.manage`) before any write; this module
 * itself is server-only and never reaches the browser.
 */

export const EMAIL_TEMPLATE_IDS = [
  'welcome',
  'password_reset',
  'signin_confirmation',
  'title_request_received',
  'title_request_imported',
  'playback_issue',
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

/** Type guard: is an arbitrary string one of the known template ids? */
export function isEmailTemplateId(value: string): value is EmailTemplateId {
  return (EMAIL_TEMPLATE_IDS as readonly string[]).includes(value);
}

export interface EmailTemplate {
  id: EmailTemplateId;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  description: string;
}

/** Placeholder substitution variables for {@link renderEmailTemplate}. */
export type EmailTemplateVars = Record<string, string | number>;

const EMAIL_TEMPLATES_SETTING_KEY = 'email.templates';
const EMAIL_TEMPLATES_SETTING_DESCRIPTION =
  'Transactional email template overrides (subject/body per template id).';

/**
 * The built-in template set. Sane default copy so every transactional flow can
 * send immediately; admins override per-template via the panel.
 */
export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateId, EmailTemplate> = {
  welcome: {
    id: 'welcome',
    subject: 'Welcome to Lumora, {{name}}!',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">Welcome to Lumora</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">Your account is ready. Browse the catalog, pick a title, and press play.</p>
    <p style="margin:0 0 24px;"><a href="{{link}}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Start watching</a></p>
    <p style="margin:0;color:#9b9ba3;font-size:13px;">Questions? Reply to this email and we will help.</p>
  </div>
</div>`,
    bodyText: `Welcome to Lumora!

Hi {{name}},

Your account is ready. Browse the catalog, pick a title, and press play.

Start watching: {{link}}

Questions? Reply to this email and we will help.`,
    description: 'Sent to a new account holder right after signup.',
  },
  password_reset: {
    id: 'password_reset',
    subject: 'Reset your Lumora password',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">Reset your password</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">We received a request to reset the password on your Lumora account. Use the link below to choose a new one — it expires shortly.</p>
    <p style="margin:0 0 24px;"><a href="{{link}}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Reset your password</a></p>
    <p style="margin:0;color:#9b9ba3;font-size:13px;">If you did not request this, you can safely ignore this email — your password will not change.</p>
  </div>
</div>`,
    bodyText: `Reset your password

Hi {{name}},

We received a request to reset the password on your Lumora account. Use the
link below to choose a new one — it expires shortly.

Reset your password: {{link}}

If you did not request this, you can safely ignore this email — your password
will not change.`,
    description: 'Sent when a user requests a password reset.',
  },
  signin_confirmation: {
    id: 'signin_confirmation',
    subject: 'New sign-in to your Lumora account',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">New sign-in to Lumora</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">A new sign-in just happened on your Lumora account. If that was you, you are all set.</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">If it was not you, review your account and sign out every device: <a href="{{link}}" style="color:#9f86ff;">Review my account</a></p>
    <p style="margin:0;color:#9b9ba3;font-size:13px;">This message is sent automatically after every successful sign-in.</p>
  </div>
</div>`,
    bodyText: `New sign-in to Lumora

Hi {{name}},

A new sign-in just happened on your Lumora account. If that was you, you are
all set.

If it was not you, review your account and sign out every device: {{link}}

This message is sent automatically after every successful sign-in.`,
    description: 'Sent after a successful sign-in to confirm the activity on the account.',
  },
  title_request_received: {
    id: 'title_request_received',
    subject: 'We got your request for {{title}}',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">We got your request</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">Thanks for requesting <strong>{{title}}</strong>. We have added it to our queue, and you will hear from us when it becomes available.</p>
    <p style="margin:0;color:#9b9ba3;font-size:13px;">Requests are reviewed in the order they arrive.</p>
  </div>
</div>`,
    bodyText: `We got your request

Hi {{name}},

Thanks for requesting {{title}}. We have added it to our queue, and you will
hear from us when it becomes available.

Requests are reviewed in the order they arrive.`,
    description: 'Confirmation that a requested title was received.',
  },
  title_request_imported: {
    id: 'title_request_imported',
    subject: '{{title}} is now available on Lumora',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">Your title is now available</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">Good news — <strong>{{title}}</strong> is now available on Lumora. Grab some popcorn and press play.</p>
    <p style="margin:0 0 24px;"><a href="{{link}}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Watch now</a></p>
  </div>
</div>`,
    bodyText: `Your title is now available

Hi {{name}},

Good news — {{title}} is now available on Lumora. Grab some popcorn and press
play.

Watch now: {{link}}`,
    description: 'Notice that a requested title is now available to watch.',
  },
  playback_issue: {
    id: 'playback_issue',
    subject: 'We received your playback report',
    bodyHtml: `<div style="background:#0b0b0f;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#121218;border:1px solid #26262e;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:22px;color:#f5f5f7;">We received your playback report</h1>
    <p style="margin:0 0 16px;color:#d5d5da;font-size:15px;line-height:1.6;">Hi {{name}},</p>
    <p style="margin:0 0 24px;color:#d5d5da;font-size:15px;line-height:1.6;">Thanks for letting us know about the playback trouble with <strong>{{title}}</strong>. Our team is looking into it.</p>
    <p style="margin:0;color:#9b9ba3;font-size:13px;">If the issue keeps happening, try a different source or a lower resolution from the player menu.</p>
  </div>
</div>`,
    bodyText: `We received your playback report

Hi {{name}},

Thanks for letting us know about the playback trouble with {{title}}. Our team
is looking into it.

If the issue keeps happening, try a different source or a lower resolution from
the player menu.`,
    description: 'Confirmation that a playback report was received.',
  },
};

/** The built-in template for an id — always defined for valid ids. */
export function defaultEmailTemplate(id: EmailTemplateId): EmailTemplate {
  return DEFAULT_EMAIL_TEMPLATES[id] as EmailTemplate;
}

/**
 * Read the raw stored overrides (not merged with defaults). Returns null when
 * nothing has been saved under `email.templates` yet.
 */
export async function readStoredEmailTemplateOverrides(): Promise<
  Partial<Record<EmailTemplateId, EmailTemplate>> | null
> {
  const service = getSupabaseServiceClient();
  const { data, error } = await service
    .from('site_settings')
    .select('value')
    .eq('key', EMAIL_TEMPLATES_SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(`readEmailTemplates failed: ${error.message}`);

  const value = data?.value;
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const overrides: Partial<Record<EmailTemplateId, EmailTemplate>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isEmailTemplateId(key)) continue; // ignore unknown keys — forward compatible
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tpl = entry as Record<string, unknown>;
    const subject = typeof tpl.subject === 'string' ? tpl.subject : '';
    const bodyHtml = typeof tpl.bodyHtml === 'string' ? tpl.bodyHtml : '';
    const bodyText = typeof tpl.bodyText === 'string' ? tpl.bodyText : '';
    if (!subject && !bodyHtml && !bodyText) continue; // empty entries count as "no override"
    overrides[key] = {
      id: key,
      subject,
      bodyHtml,
      bodyText,
      description: typeof tpl.description === 'string' ? tpl.description : defaultEmailTemplate(key).description,
    };
  }
  return overrides;
}

/**
 * The EFFECTIVE template set: stored overrides merged over the built-in
 * defaults. The panel edits and test-sends against this record.
 */
export async function getEmailTemplates(): Promise<Record<EmailTemplateId, EmailTemplate>> {
  const stored = await readStoredEmailTemplateOverrides();
  const merged = {} as Record<EmailTemplateId, EmailTemplate>;
  for (const id of EMAIL_TEMPLATE_IDS) {
    merged[id] = stored?.[id] ?? defaultEmailTemplate(id);
  }
  return merged;
}

/**
 * Persist template overrides to `site_settings` (upsert the single
 * `email.templates` key). Reconciles against whatever is already stored so a
 * template reverted to its built-in copy is dropped from the override set
 * instead of leaving stale copy behind. Writes via the service client; the
 * permission gate lives in the caller (`settings.manage`).
 */
export async function saveEmailTemplates(
  templates: Partial<Record<EmailTemplateId, EmailTemplate>>,
): Promise<void> {
  const service = getSupabaseServiceClient();

  // Actor id for audit attribution — read via the RLS-scoped client, which
  // carries the signed-in session (the service client has none).
  const session = await getSupabaseServerClient();
  const { data: user } = await session.auth.getUser();
  const updatedBy = user.user?.id ?? null;

  const base = (await readStoredEmailTemplateOverrides()) ?? {};
  const merged: Partial<Record<EmailTemplateId, EmailTemplate>> = { ...base };
  for (const id of Object.keys(templates) as EmailTemplateId[]) {
    const entry = templates[id];
    if (!entry) continue;
    const def = defaultEmailTemplate(id);
    const backToDefault =
      entry.subject === def.subject && entry.bodyHtml === def.bodyHtml && entry.bodyText === def.bodyText;
    if (backToDefault) {
      delete merged[id];
    } else {
      merged[id] = { ...entry, description: def.description };
    }
  }

  const { error } = await service.from('site_settings').upsert(
    {
      key: EMAIL_TEMPLATES_SETTING_KEY,
      value: merged as Json,
      is_public: false,
      description: EMAIL_TEMPLATES_SETTING_DESCRIPTION,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`saveEmailTemplates failed: ${error.message}`);
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Escape a substituted value for safe interpolation into an HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace `{{var}}` placeholders in a template with the given values. Values
 * interpolated into the HTML body are HTML-escaped (template copy is admin
 * authored, but the variables — names, titles, URLs — are user data); missing
 * variables render as empty text so sent mail never shows literal braces.
 */
export function renderEmailTemplate(
  tpl: Pick<EmailTemplate, 'subject' | 'bodyHtml' | 'bodyText'>,
  vars: EmailTemplateVars,
): { subject: string; html: string; text: string } {
  const render = (source: string, escape: (value: string) => string) =>
    source.replace(PLACEHOLDER_RE, (_match, name: string) => {
      const value = vars[name];
      return value == null ? '' : escape(String(value));
    });

  return {
    subject: render(tpl.subject, (value) => value),
    html: render(tpl.bodyHtml, escapeHtml),
    text: render(tpl.bodyText, (value) => value),
  };
}
