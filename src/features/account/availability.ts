export const ACCOUNT_SERVICES_UNAVAILABLE = 'Accounts and account synchronization are unavailable. Public browsing and guest playback remain available.';

export function isStoredCatalogId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
