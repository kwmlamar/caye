import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import {
  summarizeIntake,
  summarizeIntakeBody,
  type BriefField,
  type IntakeSummary,
} from '@/lib/operator-brief'
import type { Tool } from '../types'
import {
  identityFromConversation,
  identityFromField,
  mergeIdentities,
  summarizeReachability,
  classifyMatch,
  type Identity,
} from '../../customer-profile'

interface GetCustomerInput {
  query: string
}

interface ContactRow {
  id: string
  name: string | null
  phone_number: string | null
  email: string | null
  channel_type: string | null
  last_message_at: string | null
  notes: string | null
}

interface ConvRow {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  last_message_at: string | null
  contact_id: string | null
  metadata: Record<string, unknown> | null
}

interface CustomerMatch {
  source: 'contact' | 'conversation'
  contact_id: string | null
  conversation_id: string | null
  name: string | null
  /** Every address attributable to this match, from every source. Shaped
   *  into emails/phones/absent by summarizeReachability on the way out. */
  identities: (Identity | null)[]
  channel: string | null
  last_seen: string | null
  notes: string | null
  /** What the customer actually asked for on the intake form — party size,
   *  date, tour, and their own free-text note. Null when the thread didn't
   *  start from a parseable form submission. */
  intake: IntakeSummary | null
}

/**
 * Pull the intake fields out of a conversation's stored metadata.
 *
 * Web3Forms-style intake lands in metadata.form_fields.fields as an ordered
 * [{label, value}] array — already parsed at ingest, so there's nothing to
 * re-derive from the message body. Defensive about shape because metadata is
 * untyped jsonb written by several ingest paths.
 */
function intakeFromMetadata(metadata: unknown): IntakeSummary | null {
  if (!metadata || typeof metadata !== 'object') return null
  const formFields = (metadata as { form_fields?: unknown }).form_fields
  if (!formFields || typeof formFields !== 'object') return null
  const raw = (formFields as { fields?: unknown }).fields
  if (!Array.isArray(raw)) return null

  const fields: BriefField[] = raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      label: String(f.label ?? '').trim(),
      value: String(f.value ?? '').trim(),
    }))
    .filter((f) => f.label && f.value)

  return fields.length > 0 ? summarizeIntake(fields) : null
}

export const getCustomer: Tool<GetCustomerInput> = {
  name: 'get_customer',
  description:
    "Look up a customer by name, phone, or email. Searches the contacts table AND conversation threads — every legitimate inbound conversation resolves a contact at ingest now (2026-08-13 identity-ingestion fix), so a thread with no contact_id is the rare exception (a backfill gap, an automated sender that was correctly skipped) rather than the norm; still check both so nothing recent falls through. " +
    "READ `match` FIRST. 'unique' -> `contact` holds the one person. 'ambiguous' -> `candidates` holds several and there is deliberately NO single contact: say who they might be and ask which, never pick one. 'none' -> nobody matched. " +
    "Contact details are `emails` and `phones` (each with provenance: verified = we have exchanged messages there, stated = an operator told us, claimed = typed into a form) plus `relay_only` for forwarding addresses that reach them but are not their own. " +
    "`absent` lists what we checked for and genuinely do not have — that is the ONLY basis for telling the operator we don't have something. `not_checked` lists what this call did not fetch; never report those as missing. " +
    "When the thread began as a website intake form, `intake` carries what the customer actually requested — party size, date, tour, free-text note. Read it before drafting: if it has a party size, quote for that party size. " +
    "This is a summary, not the conversation — call get_customer_history for the full thread.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search term — a name, phone number, or email address.',
      },
    },
    required: ['query'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const q = args.query.trim()
    if (!q) return { ok: false, error: 'Empty query' }

    const { data: accounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', ctx.workspaceId)
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)

    const [contactsRes, convsRes] = await Promise.all([
      supabase
        .from('contacts')
        .select(
          'id, name, phone_number, email, channel_type, last_message_at, notes'
        )
        .eq('customer_id', ctx.workspaceId)
        .or(`name.ilike.%${q}%,phone_number.ilike.%${q}%,email.ilike.%${q}%`)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(5),
      accountIds.length > 0
        ? supabase
            .from('unified_conversations')
            .select(
              'id, customer_name, customer_id, channel_type, last_message_at, contact_id, metadata'
            )
            .in('connected_account_id', accountIds)
            .or(`customer_name.ilike.%${q}%,customer_id.ilike.%${q}%`)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(5)
        : Promise.resolve({ data: [] as ConvRow[], error: null }),
    ])

    if (contactsRes.error) return { ok: false, error: contactsRes.error.message }

    // Keyed so a conversation match MERGES into the contact row for the same
    // person instead of being dropped. The old dedup skipped the conversation
    // outright, discarding the two fields only it carries — conversation_id
    // and intake. That was a latent second way to lose intake; the primary one
    // was this query never selecting metadata at all (Robert, 2026-08-06:
    // "Guests: 5" was on file and the agent still drafted "I don't know his
    // party size").
    const byKey = new Map<string, CustomerMatch>()
    const matches: CustomerMatch[] = []

    const remember = (key: string, match: CustomerMatch) => {
      if (key) byKey.set(key, match)
      matches.push(match)
    }

    for (const c of (contactsRes.data ?? []) as ContactRow[]) {
      const key = (c.email || c.phone_number || c.name || '').toLowerCase()
      if (key && byKey.has(key)) continue
      remember(key, {
        source: 'contact',
        contact_id: c.id,
        conversation_id: null,
        name: c.name,
        identities: [
          identityFromField('email', c.email, 'verified', c.last_message_at),
          identityFromField('whatsapp', c.phone_number, 'verified', c.last_message_at),
        ],
        channel: c.channel_type,
        last_seen: c.last_message_at,
        notes: c.notes,
        intake: null,
      })
    }

    for (const c of (convsRes.data ?? []) as ConvRow[]) {
      // Shared with get_customer_history so the two tools can never
      // disagree about whether a thread has contact details.
      const threadIdentity = identityFromConversation(
        c.channel_type,
        c.customer_id,
        c.last_message_at
      )
      const intake = intakeFromMetadata(c.metadata)
      const key = (c.customer_name || c.customer_id || '').toLowerCase()

      const existing = key ? byKey.get(key) : undefined
      if (existing) {
        existing.conversation_id ??= c.id
        existing.contact_id ??= c.contact_id
        existing.identities.push(
          threadIdentity,
          identityFromField('email', intake?.email, 'claimed'),
          identityFromField('whatsapp', intake?.phone, 'claimed')
        )
        existing.intake ??= intake
        existing.notes ??= intake?.notes ?? null
        continue
      }

      remember(key, {
        source: 'conversation',
        contact_id: c.contact_id,
        conversation_id: c.id,
        name: c.customer_name ?? intake?.name ?? null,
        identities: [
          threadIdentity,
          identityFromField('email', intake?.email, 'claimed'),
          identityFromField('whatsapp', intake?.phone, 'claimed'),
        ],
        channel: c.channel_type,
        last_seen: c.last_message_at,
        notes: intake?.notes ?? null,
        intake,
      })
    }

    const top = matches.slice(0, 5)

    // Fallback for threads whose metadata predates form_fields (or came in via
    // an ingest path that doesn't store it): the intake body is still sitting
    // in the first inbound message. One batched query for the whole result set.
    const needsIntake = top.filter((m) => m.conversation_id && !m.intake)
    if (needsIntake.length > 0) {
      const { data: msgs } = await supabase
        .from('unified_messages')
        .select('conversation_id, content, sent_at')
        .in('conversation_id', needsIntake.map((m) => m.conversation_id as string))
        .eq('sender_type', 'customer')
        .order('sent_at', { ascending: true })
        .limit(60)

      const firstByConv = new Map<string, string>()
      for (const m of (msgs ?? []) as { conversation_id: string; content: string | null }[]) {
        if (!firstByConv.has(m.conversation_id) && m.content) {
          firstByConv.set(m.conversation_id, m.content)
        }
      }
      for (const match of needsIntake) {
        const body = firstByConv.get(match.conversation_id as string)
        if (!body) continue
        const intake = summarizeIntakeBody(body)
        if (!intake) continue
        match.intake = intake
        match.identities.push(
          identityFromField('email', intake.email, 'claimed'),
          identityFromField('whatsapp', intake.phone, 'claimed')
        )
        match.notes ??= intake.notes
      }
    }

    // Shape identities into the reachability block, then classify. An
    // ambiguous result carries NO primary contact — see classifyMatch.
    const shaped = top.map(({ identities, ...rest }) => ({
      ...rest,
      ...summarizeReachability(mergeIdentities(identities)),
    }))

    return {
      ok: true,
      data: {
        query: q,
        ...classifyMatch(shaped),
        count: matches.length,
      },
    }
  },
}
