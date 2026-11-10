'use server';

import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { TRANSCODE_UNAVAILABLE_MESSAGE, type TranscodeActionState } from './transcode-state';

/**
 * This web app has no authorized transcode executor. Keep the
 * action fail-closed even for direct/stale form submissions. Do not import the
 * offline Node CLI here: a hosting change does not authorize web execution.
 */
export async function transcodeUploadAction(
  _prev: TranscodeActionState,
  _formData: FormData,
): Promise<TranscodeActionState> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
  } catch {
    return { status: 'error', message: 'You need the provider.manage permission to transcode media.' };
  }

  return { status: 'error', message: TRANSCODE_UNAVAILABLE_MESSAGE };
}
