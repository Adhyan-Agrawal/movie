/** Barrel for Zod validation schemas and API envelope helpers (Sections 6/14). */

export {
  TITLE_TYPES,
  TITLE_STATUSES,
  TITLE_VISIBILITIES,
  MATURITY_RATINGS,
  slugSchema,
  imdbIdSchema,
  titleInputSchema,
  titleUpdateSchema,
} from './title';
export type { TitleInput, TitleUpdate } from './title';

export {
  MEDIA_SOURCE_KINDS,
  SOURCE_QUALITIES,
  geoPolicySchema,
  mediaSourceInputSchema,
  isAllowedHost,
  isPrivateOrLoopbackHost,
} from './source';
export type { MediaSourceKind, MediaSourceInput, GeoPolicy } from './source';

export {
  settingKeySchema,
  jsonValueSchema,
  siteSettingUpdateSchema,
} from './settings';
export type { SiteSettingUpdate, JsonValue } from './settings';

export { ok, fail, apiError, isOk, newRequestId } from './api';
export type { ApiResult, ApiError } from './api';
