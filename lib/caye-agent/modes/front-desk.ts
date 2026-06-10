import 'server-only'

/**
 * Front-desk mode entry — placeholder for slice 1 of epic #35.
 *
 * Today the customer-facing reply path runs through lib/caye-reply.ts
 * directly and is wired into the webhook handlers (zoho-email,
 * whatsapp, instagram, messenger). That continues to work unchanged
 * during the back-office build to avoid regressing customers while we
 * build the operator surface.
 *
 * A later slice extracts caye-reply.ts behavior behind this file so
 * the cayeAgent({ mode: 'front-desk' }) call path becomes meaningful.
 * For now this exists only to lock the directory shape so subsequent
 * slices don't have to migrate the API surface.
 */
export const FRONT_DESK_MODE_NOT_YET_ROUTED = true as const
