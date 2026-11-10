export function safeAuthReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/account';
  try {
    const target = new URL(value, 'https://local.invalid');
    // Dot-segment normalization can turn /a/..//host into a protocol-relative path.
    if (target.origin !== 'https://local.invalid' || target.pathname.startsWith('//')
      || /^\/(?:signin|signup)(?:\/|$)/.test(target.pathname) || target.pathname.startsWith('/auth/')) return '/account';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return '/account'; }
}

/** Use the configured canonical origin, never Host or forwarded request headers. */
export function authCallbackUrl(appUrl: string, next?: string): URL | null {
  try {
    const target = new URL(appUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash
      || (target.protocol !== 'https:' && !(target.protocol === 'http:' && local && process.env.NODE_ENV !== 'production'))
      || (local && process.env.NODE_ENV === 'production')) return null;
    target.pathname = '/auth/callback';
    target.searchParams.set('next', safeAuthReturnPath(next));
    return target;
  } catch { return null; }
}
