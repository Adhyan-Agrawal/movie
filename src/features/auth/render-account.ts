import 'server-only';

import { cache } from 'react';
import { getVerifiedAccount } from './verified-account';

// RSC reads only. React owns the request lifetime; actions and routes must verify afresh.
export const getRenderAccount = cache(() => getVerifiedAccount());
