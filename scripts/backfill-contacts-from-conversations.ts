// One-time backfill: create `contacts` rows for existing WhatsApp/Instagram/
// Messenger conversations that predate the webhook fix (contact creation
// only ever worked for the Zoho email channel before this pass — see
// app/api/webhooks/{whatsapp,instagram,messenger}/route.ts). Safe to re-run;
// upserts are keyed the same way the webhooks now key new contacts.
//
// Run with: npx tsx scripts/backfill-contacts-from-conversations.ts

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const SOCIAL_CHANNELS = ['whatsapp', 'instagram', 'messenger'] as const

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: conversations, error } = await supabase
    .from('unified_conversations')
    .select('id, channel_type, channel_conversation_id, customer_name, connected_account_id')
    .in('channel_type', SOCIAL_CHANNELS)
    .is('contact_id', null)

  if (error) {
    console.error('Failed to load conversations:', error.message)
    process.exit(1)
  }

  if (!conversations?.length) {
    console.log('No conversations need backfilling.')
    return
  }

  console.log(`Found ${conversations.length} conversation(s) without a contact_id.`)

  const accountIds = [...new Set(conversations.map((c) => c.connected_account_id))]
  const { data: accounts, error: accErr } = await supabase
    .from('connected_accounts')
    .select('id, user_id')
    .in('id', accountIds)

  if (accErr) {
    console.error('Failed to load connected accounts:', accErr.message)
    process.exit(1)
  }

  const workspaceByAccount = new Map((accounts ?? []).map((a) => [a.id, a.user_id as string]))

  let created = 0
  let linked = 0
  let skipped = 0

  for (const conv of conversations) {
    const workspaceId = workspaceByAccount.get(conv.connected_account_id)
    if (!workspaceId) {
      console.warn(`  Skipping conversation ${conv.id} — no connected account found`)
      skipped++
      continue
    }

    const isWhatsapp = conv.channel_type === 'whatsapp'
    const nowISO = new Date().toISOString()

    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .upsert(
        {
          customer_id: workspaceId,
          name: conv.customer_name,
          phone_number: isWhatsapp ? conv.channel_conversation_id : null,
          channel_type: conv.channel_type,
          channel_id: conv.channel_conversation_id,
          updated_at: nowISO,
        },
        { onConflict: 'customer_id,channel_type,channel_id', ignoreDuplicates: false }
      )
      .select('id')
      .single()

    if (contactErr || !contact) {
      console.warn(`  Contact upsert failed for conversation ${conv.id}:`, contactErr?.message)
      skipped++
      continue
    }

    created++

    const { error: linkErr } = await supabase
      .from('unified_conversations')
      .update({ contact_id: contact.id })
      .eq('id', conv.id)

    if (linkErr) {
      console.warn(`  Failed to link conversation ${conv.id} to contact ${contact.id}:`, linkErr.message)
      continue
    }
    linked++
  }

  console.log(`Done. Contacts created/matched: ${created}, conversations linked: ${linked}, skipped: ${skipped}`)
}

main()
