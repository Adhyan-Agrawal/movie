import { isIP } from 'node:net';

/**
 * Trust only Netlify's connecting-IP header, not client-supplied forwarding chains.
 * SITE_ID is a documented Functions runtime variable; NETLIFY is build-only.
 * https://answers.netlify.com/t/is-the-client-ip-header-going-to-be-supported-long-term/11203/2
 */
export function requestIp(headers: Headers): string | null {
  if (!process.env.SITE_ID) return null;
  const address = headers.get('x-nf-client-connection-ip');
  if (!address || address.length > 45 || /[\s,%]/.test(address)) return null;
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return null;
}
