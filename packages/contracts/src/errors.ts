import { z } from 'zod';

/** Stable machine-readable API error codes. */
export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'csrf_failed',
  'origin_not_allowed',
  'not_found',
  'conflict',
  'idempotency_conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'storage_quota_exceeded',
  'media_not_ready',
  'media_in_use',
  'playlist_in_use',
  'app_in_use',
  'schedule_in_use',
  'layout_in_use',
  'last_owner',
  'publication_rejected',
  'pairing_code_invalid',
  'pairing_expired',
  'pairing_locked',
  'device_revoked',
  'url_expired',
  'url_signature_invalid',
  'range_not_satisfiable',
  'service_unavailable',
  // 503s of POST /api/alert-recipients: nothing was stored, or the address was stored but its
  // confirmation e-mail was not sent. Each has a definite outcome the portal states.
  'mail_not_configured',
  'confirmation_not_sent',
  // 500 of a POST, PUT, PATCH or DELETE whose COMMIT the database did not confirm: the change
  // may have been saved. No Retry-After, since sending it again could repeat it; the client
  // reloads to check (D9). A GET or HEAD answers internal_error instead.
  'commit_outcome_unknown',
  'internal_error',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * The one HTTP status of each code (adoption plan section 2.2, step 28). The API's HttpError takes
 * its status from here, so an HttpError cannot carry a status other than its code's (`not_found`
 * with 403, say). The API's error handler keeps a framework 4xx's own status under the nearest
 * code: 406 is mapped to bad_request, and a 4xx it does not list (416, say) falls back to
 * bad_request. eslint.config.js reads the 403 codes
 * from this table for its lint of API source, so a new 403 code is covered there as soon as it is
 * added here.
 */
export const STATUS_OF = Object.freeze({
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  origin_not_allowed: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  storage_quota_exceeded: 413,
  media_not_ready: 409,
  media_in_use: 409,
  playlist_in_use: 409,
  app_in_use: 409,
  schedule_in_use: 409,
  layout_in_use: 409,
  last_owner: 409,
  publication_rejected: 422,
  pairing_code_invalid: 400,
  // No route answers it today: a poll of an expired pairing answers 200 { status: 'expired' },
  // and a claim of an expired code answers pairing_code_invalid. 400, as that code.
  pairing_expired: 400,
  pairing_locked: 429,
  device_revoked: 401,
  url_expired: 403,
  url_signature_invalid: 403,
  range_not_satisfiable: 416,
  service_unavailable: 503,
  mail_not_configured: 503,
  confirmation_not_sent: 503,
  commit_outcome_unknown: 500,
  internal_error: 500,
} as const satisfies Record<ApiErrorCode, number>);

export const ApiErrorDetailSchema = z
  .object({
    /** Dotted path to the offending field, or an item reference such as items[2]. */
    path: z.string().max(200),
    message: z.string().max(500),
    code: z.string().max(80).optional(),
  })
  .strict();
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

/** Envelope for every non-2xx JSON response from the API. */
export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        /** Human-readable, safe to show to an operator. Never contains secrets or stack traces. */
        message: z.string().max(500),
        details: z.array(ApiErrorDetailSchema).max(100).optional(),
        requestId: z.string().max(100).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: { details?: ApiErrorDetail[]; requestId?: string } = {},
): ApiError {
  return { error: { code, message, ...extra } };
}
