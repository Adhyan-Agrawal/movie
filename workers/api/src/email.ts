import { assertEmailDeliveryReady } from "./readiness";

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendTransactionalEmail(env: Env, message: TransactionalEmail): Promise<void> {
  assertEmailDeliveryReady(env);
  const from = parseAddress(env.EMAIL_FROM);
  await env.EMAIL.send({
    to: message.to,
    from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export async function sendVerificationEmail(env: Env, email: string, url: string): Promise<void> {
  await sendTransactionalEmail(env, buildVerificationEmail(email, url));
}

export function buildVerificationEmail(email: string, url: string): TransactionalEmail {
  const safeUrl = escapeHtml(url);
  return {
    to: email,
    subject: "Verify your Lumora email",
    text: `Verify your Lumora email: ${url}`,
    html: `<p>Verify your Lumora email.</p><p><a href="${safeUrl}">Verify email</a></p>`,
  };
}

export async function sendPasswordResetEmail(env: Env, email: string, url: string): Promise<void> {
  await sendTransactionalEmail(env, buildPasswordResetEmail(email, url));
}

export function buildPasswordResetEmail(email: string, url: string): TransactionalEmail {
  const safeUrl = escapeHtml(url);
  return {
    to: email,
    subject: "Reset your Lumora password",
    text: `Reset your Lumora password: ${url}`,
    html: `<p>A password reset was requested for your Lumora account.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, ignore this message.</p>`,
  };
}

function parseAddress(value: string): string | { email: string; name: string } {
  const match = /^\s*([^<>]{1,100})\s*<([^<>\s]+@[^<>\s]+)>\s*$/u.exec(value);
  return match?.[1] && match[2] ? { name: match[1].trim(), email: match[2] } : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
