// One-time backfill: resolve/create `contacts` rows for existing
// conversations that predate a working identity-resolution path on their
// channel, and link `unified_conversations.contact_id`.
//
// History: contact creation only ever worked for the Zoho *webhook* email
// path until 2026-08-13, when the WhatsApp/Instagram/Messenger webhooks
// also gained it (see the original version of this script). This pass
// extends the same backfill to email/gmail — the two live production email
// pollers (app/api/email/poll, app/api/email/gmail-poll) never wrote a
// contacts row at all, which is why a real website-intake conversation
// (Karin Roberts, karinroberts63@gmail.com) had rich context but was
// invisible to the People page. See the people-identity-ingestion audit.
//
// Safe to re-run: every write is either an upsert keyed on the same unique
// constraints the webhooks use, or an UPDATE of contact_id scoped to rows
// still missing one — a second run finds nothing left to do.
//
// Deliberately conservative, per the audit's identity-resolution rules:
//   - internal_sales workspaces are skipped entirely. Their canonical
//     identity is outreach_leads, not contacts — creating contacts rows
//     there would be a second, competing identity space, not a fix.
//   - automated/system senders (isNoReplySender) never get a Person.
//   - a conversation's customer_id that isn't email-shaped (e.g. Zoho
//     payment-receipt synthetic ids like "receipt_000152955956", or other
//     non-email artifacts) is not a strong identifier — skipped as
//     ambiguous rather than guessed at, per "be conservative about fuzzy
//     matching."
//
// Run with (dotenv isn't installed in this repo — source env vars directly,
// same convention as scripts/source-leads.ts):
//   set -a && source .env.local && set +a && npx tsx scripts/backfill-contacts-from-conversations.ts

import { createClient } from '@supabase/supabase-js'
import { resolveOrCreateContact, isEmailShaped, type SupabaseLike } from '../lib/contacts/resolve-contact'
import { isNoReplySender } from '../lib/sender-classifier'

const SOCIAL_CHANNELS = ['whatsapp', 'instagram', 'messenger'] as const
const EMAIL_CHANNELS = ['email', 'gmail'] as const

async function main() {
  // resolveOrCreateContact only needs `.from('contacts')`, satisfied
  // structurally by the real client — the rest of this script uses the
  // client's full (untyped) query surface directly.
  const supabase: SupabaseLike & Record<string, any> = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  ) as any

  await backfillSocialChannels(supabase)
  await backfillEmailChannels(supabase)
}

async function backfillSocialChannels(supabase: any) {
  const { data: conversations, error } = await supabase
    .from('unified_conversations')
    .select('id, channel_type, channel_conversation_id, customer_name, connected_account_id')
    .in('channel_type', SOCIAL_CHANNELS)
    .is('contact_id', null)

  if (error) {
    console.error('[social] Failed to load conversations:', error.message)
    return
  }
  if (!conversations?.length) {
    console.log('[social] No conversations need backfilling.')
    return
  }
  console.log(`[social] Found ${conversations.length} conversation(s) without a contact_id.`)

  const accountIds = [...new Set(conversations.map((c: any) => c.connected_account_id))]
  const { data: accounts, error: accErr } = await supabase
    .from('connected_accounts')
    .select('id, user_id')
    .in('id', accountIds)
  if (accErr) {
    console.error('[social] Failed to load connected accounts:', accErr.message)
    return
  }
  const workspaceByAccount = new Map((accounts ?? []).map((a: any) => [a.id, a.user_id as string]))

  let linked = 0
  let skipped = 0

  for (const conv of conversations as any[]) {
    const workspaceId = workspaceByAccount.get(conv.connected_account_id)
    if (!workspaceId) {
      console.warn(`[social]   Skipping conversation ${conv.id} — no connected account found`)
      skipped++
      continue
    }

    const contact = await resolveOrCreateContact(supabase, {
      workspaceId,
      channelType: conv.channel_type,
      channelId: conv.channel_conversation_id,
      name: conv.customer_name,
      at: new Date().toISOString(),
    })
    if (!contact) {
      console.warn(`[social]   Contact resolution failed for conversation ${conv.id}`)
      skipped++
      continue
    }

    const { error: linkErr } = await supabase
      .from('unified_conversations')
      .update({ contact_id: contact.id })
      .eq('id', conv.id)
    if (linkErr) {
      console.warn(`[social]   Failed to link conversation ${conv.id}:`, linkErr.message)
      skipped++
      continue
    }
    linked++
  }

  console.log(`[social] Done. Linked: ${linked}, skipped: ${skipped}`)
}

async function backfillEmailChannels(supabase: any) {
  // internal_sales workspaces are excluded at the query level — their
  // canonical identity is outreach_leads, not contacts (see file header).
  const { data: salesWorkspaces } = await supabase
    .from('customers')
    .select('id')
    .eq('workspace_kind', 'internal_sales')
  const salesWorkspaceIds = new Set((salesWorkspaces ?? []).map((w: any) => w.id as string))

  const { data: conversations, error } = await supabase
    .from('unified_conversations')
    .select('id, channel_type, customer_id, customer_name, last_message_at, connected_account_id')
    .in('channel_type', EMAIL_CHANNELS)
    .is('contact_id', null)

  if (error) {
    console.error('[email] Failed to load conversations:', error.message)
    return
  }
  if (!conversations?.length) {
    console.log('[email] No conversations need backfilling.')
    return
  }

  const accountIds = [...new Set(conversations.map((c: any) => c.connected_account_id))]
  const { data: accounts, error: accErr } = await supabase
    .from('connected_accounts')
    .select('id, user_id')
    .in('id', accountIds)
  if (accErr) {
    console.error('[email] Failed to load connected accounts:', accErr.message)
    return
  }
  const workspaceByAccount = new Map((accounts ?? []).map((a: any) => [a.id, a.user_id as string]))

  let linked = 0
  let created = 0
  let automatedSkipped = 0
  let ambiguousSkipped = 0
  let noAccountSkipped = 0

  for (const conv of conversations as any[]) {
    const workspaceId = workspaceByAccount.get(conv.connected_account_id)
    if (!workspaceId) {
      noAccountSkipped++
      continue
    }
    if (salesWorkspaceIds.has(workspaceId)) continue // by design, not a bug

    const email = String(conv.customer_id ?? '')
    if (!isEmailShaped(email)) {
      console.warn(`[email]   Ambiguous — customer_id not email-shaped, conversation ${conv.id}: "${email}"`)
      ambiguousSkipped++
      continue
    }
    if (isNoReplySender(email)) {
      automatedSkipped++
      continue
    }

    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .eq('customer_id', workspaceId)
      .eq('email', email.toLowerCase())
      .maybeSingle()

    const contact = existingContact
      ? { id: existingContact.id as string }
      : await resolveOrCreateContact(supabase, {
          workspaceId,
          channelType: conv.channel_type === 'gmail' ? 'gmail' : 'email',
          channelId: email,
          name: conv.customer_name,
          at: conv.last_message_at ?? new Date().toISOString(),
        })

    if (!contact) {
      console.warn(`[email]   Contact resolution failed for conversation ${conv.id} (${email})`)
      ambiguousSkipped++
      continue
    }
    if (!existingContact) created++

    const { error: linkErr } = await supabase
      .from('unified_conversations')
      .update({ contact_id: contact.id })
      .eq('id', conv.id)
    if (linkErr) {
      console.warn(`[email]   Failed to link conversation ${conv.id}:`, linkErr.message)
      continue
    }
    linked++
  }

  console.log(
    `[email] Done. Contacts created: ${created}, conversations linked: ${linked}, ` +
      `automated skipped: ${automatedSkipped}, ambiguous skipped: ${ambiguousSkipped}, ` +
      `no-account skipped: ${noAccountSkipped}.`
  )
}

main()
