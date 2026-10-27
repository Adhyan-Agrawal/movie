export function safeAuthReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/account';
  try {
    const target = new URL(value, 'https://local.invalid');
    return target.origin === 'https://local.invalid' ? `${target.pathname}${target.search}${target.hash}` : '/account';
  } catch { return '/account'; }
}
