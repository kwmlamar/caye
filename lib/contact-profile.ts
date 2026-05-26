import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { ContactStyleProfile } from '@/types/database'
import {
  FIRST_EXTRACTION_AT,
  shouldExtractContactProfile,
} from '@/lib/contact-profile-trigger'

export type { ContactStyleProfile }

/**
 * How many of the contact's most recent inbound messages we feed Claude
 * when building the style profile. Spans all of their conversations.
 */
const SAMPLE_SIZE = 20

/**
 * Ask Claude to summarise a customer's communication style from their
 * inbound messages. The output is intentionally narrow — 3 fields, used
 * by Caye to mirror the customer's energy, not to impersonate them.
 */
export async function extractContactStyleProfile(
  samples: string[]
): Promise<ContactStyleProfile> {
  const client = new Anthropic()

  const samplesText = samples
    .map((s, i) => `--- Message ${i + 1} ---\n${s.trim()}`)
    .join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `Analyze these inbound messages from a single customer and summarise their communication style.
Return ONLY valid JSON — no markdown, no explanation:
{
  "formality": "casual",
  "message_style": "brief",
  "language_notes": "1-2 short sentences on notable patterns — emoji use, dialect, abbreviations, punctuation habits, etc."
}
The formality field must be exactly one of: "casual" or "formal".
The message_style field must be exactly one of: "brief" or "chatty" or "detailed".`,
    messages: [
      {
        role: 'user',
        content: `Analyze these customer messages and extract their style profile:\n\n${samplesText}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(text) as ContactStyleProfile
}

/**
 * Fire-and-forget hook called after each inbound message from a contact.
 *
 * Increments the contact's inbound_message_count, and if the new count
 * is at FIRST_EXTRACTION_AT or a multiple of REFRESH_EVERY beyond it,
 * pulls the contact's recent inbound messages and re-extracts their
 * style profile in the background.
 *
 * Safe to .catch() at the caller — any failure is logged but never
 * surfaced because customer style is non-critical to reply correctness.
 */
export async function maybeRefreshContactProfile(contactId: string): Promise<void> {
  const supabase = createServiceClient()

  // Atomic-ish increment via select-then-update. Acceptable here because
  // inbound messages from the same contact arrive serially in practice.
  const { data: current, error: readErr } = await supabase
    .from('contacts')
    .select('inbound_message_count')
    .eq('id', contactId)
    .maybeSingle()

  if (readErr || !current) {
    console.warn(`[contact-profile] Could not read contact ${contactId}:`, readErr?.message)
    return
  }

  const newCount = (current.inbound_message_count ?? 0) + 1

  await supabase
    .from('contacts')
    .update({ inbound_message_count: newCount, updated_at: new Date().toISOString() })
    .eq('id', contactId)

  if (!shouldExtractContactProfile(newCount)) return

  // Pull the contact's most recent inbound messages across ALL conversations
  // (a contact may have multiple threads — we want the union).
  const { data: samples, error: samplesErr } = await supabase
    .from('unified_messages')
    .select('content, unified_conversations!inner(contact_id)')
    .eq('unified_conversations.contact_id', contactId)
    .eq('sender_type', 'customer')
    .not('content', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(SAMPLE_SIZE)

  if (samplesErr || !samples?.length) {
    console.warn(`[contact-profile] No samples for contact ${contactId}:`, samplesErr?.message)
    return
  }

  const bodies = samples
    .map(s => (s.content ?? '').trim())
    .filter(Boolean)

  if (bodies.length < FIRST_EXTRACTION_AT) return

  try {
    const profile = await extractContactStyleProfile(bodies)
    await supabase
      .from('contacts')
      .update({
        ai_contact_profile: profile,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId)
    console.log(
      `[contact-profile] Refreshed profile for contact ${contactId} ` +
        `(count=${newCount}, samples=${bodies.length}, ${profile.formality}/${profile.message_style})`
    )
  } catch (err) {
    console.error(`[contact-profile] Extraction failed for contact ${contactId}:`, err)
  }
}
