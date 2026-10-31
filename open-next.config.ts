import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Persistent ISR requires an account-owned R2 bucket. Keep the adapter's
// documented dummy cache until that resource is explicitly provisioned.
export default defineCloudflareConfig();
