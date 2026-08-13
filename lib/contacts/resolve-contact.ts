import { isNoReplySender } from '@/lib/sender-classifier'

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>

/** Minimal shape this module needs from a Supabase client — matches
 *  createServiceClient()'s `.from(table).upsert(...).select(...).single()`
 *  chain, without pulling in the full generated client type. */
interface ContactsTable {
  upsert(
    row: Record<string, unknown>,
    opts: { onConflict: string; ignoreDuplicates: boolean }
  ): {
    select(cols: string): { single(): QueryResult<{ id: string }> }
  }
}
export interface SupabaseLike {
  from(table: 'contacts'): ContactsTable
}

export type ChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'gmail'

export interface ResolveContactInput {
  workspaceId: string
  channelType: ChannelType
  /** Phone/PSID for social channels; email address for email/gmail. */
  channelId: string
  name: string | null
  /** ISO timestamp of the message that triggered this resolution — used
   *  for first_message_at/last_message_at on create/update. */
  at: string
}

export interface ResolvedContact {
  id: string
}

const EMAIL_CHANNELS = new Set<ChannelType>(['email', 'gmail'])
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Whether a string is shaped like a real email address — as opposed to a
 * synthetic identity string some ingest paths use as unified_conversations.
 * customer_id (e.g. Zoho payment-receipt tracking ids like
 * "receipt_000152955956"). Not a strong identifier, so callers should treat
 * a false here as ambiguous ("preserve separate identities rather than
 * corrupting relationship history") rather than attempt a Person match.
 */
export function isEmailShaped(value: string): boolean {
  return EMAIL_SHAPE_RE.test(value)
}

/**
 * Central identity-resolution entry point for every inbound channel —
 * finds or creates the one `contacts` row for a (workspace, channel
 * identity), or returns null when the sender isn't a legitimate human/
 * business relationship (automated/system senders never get a Person
 * record; see lib/sender-classifier.ts).
 *
 * Dedup keys mirror the DB's own unique constraints exactly:
 *   - email/gmail: (customer_id, email) — contacts_email_workspace_unique
 *   - whatsapp/instagram/messenger: (customer_id, channel_type, channel_id)
 *     — contacts_channel_identity_unique
 *
 * Extracted 2026-08-13 from four near-identical inline upserts in the
 * whatsapp/instagram/messenger/zoho-email webhooks so every inbound path
 * (including the two email pollers that never had one) resolves identity
 * the same way. See Products/Caye people-identity-ingestion audit.
 *
 * Deliberately NOT 'server-only' — it takes a Supabase client as a
 * parameter rather than creating one, so the one-time backfill script
 * (scripts/backfill-contacts-from-conversations.ts, a plain tsx script
 * outside the Next.js server runtime) can reuse this exact resolution
 * logic instead of re-implementing it.
 */
export async function resolveOrCreateContact(
  supabase: SupabaseLike,
  input: ResolveContactInput
): Promise<ResolvedContact | null> {
  const isEmail = EMAIL_CHANNELS.has(input.channelType)

  if (isEmail) {
    const email = input.channelId.toLowerCase().trim()
    if (!email) return null
    if (!isEmailShaped(email)) return null
    if (isNoReplySender(email)) return null

    const nowISO = new Date().toISOString()
    const { data, error } = await supabase
      .from('contacts')
      .upsert(
        {
          customer_id: input.workspaceId,
          email,
          name: input.name || email,
          // Stored as 'email' regardless of gmail vs Zoho transport — the
          // Person is "reachable by email," not "reachable via a specific
          // mail provider." Matches the existing zoho-email webhook's
          // convention so gmail-poll doesn't create a parallel identity
          // shape for the same underlying relationship.
          channel_type: 'email',
          channel_id: email,
          first_message_at: input.at,
          last_message_at: input.at,
          updated_at: nowISO,
        },
        { onConflict: 'customer_id,email', ignoreDuplicates: false }
      )
      .select('id')
      .single()

    if (error || !data) return null
    return { id: data.id }
  }

  if (!input.channelId) return null
  const nowISO = new Date().toISOString()
  const { data, error } = await supabase
    .from('contacts')
    .upsert(
      {
        customer_id: input.workspaceId,
        name: input.name,
        phone_number: input.channelId,
        channel_type: input.channelType,
        channel_id: input.channelId,
        first_message_at: input.at,
        last_message_at: input.at,
        updated_at: nowISO,
      },
      { onConflict: 'customer_id,channel_type,channel_id', ignoreDuplicates: false }
    )
    .select('id')
    .single()

  if (error || !data) return null
  return { id: data.id }
}
