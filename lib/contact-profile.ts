import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { ContactStyleProfile } from '@/types/database'
import {
  FIRST_EXTRACTION_AT,
  shouldExtractContactProfile,
} from '@/lib/contact-profile-trigger'
import type { CustomerFacts } from '@/lib/customer-facts'

export type { ContactStyleProfile, CustomerFacts }

export interface ContactStyleAndFacts {
  style: ContactStyleProfile
  facts: CustomerFacts
}

/**
 * How many of the contact's most recent inbound messages we feed Claude
 * when building the style profile. Spans all of their conversations.
 */
const SAMPLE_SIZE = 20

/**
 * Ask Claude to summarise a customer's communication style AND extract
 * operational facts they've told us (allergies, mobility, group, etc.)
 * from their inbound messages. Single Claude call returns both — saves
 * tokens vs. two separate calls.
 *
 * The style fields are intentionally narrow (3 fields, used by Caye to
 * mirror tone). The facts fields are intentionally optional (only return
 * facts the customer ACTUALLY mentioned — don't invent them).
 */
export async function extractContactStyleAndFacts(
  samples: string[]
): Promise<ContactStyleAndFacts> {
  const client = new Anthropic()

  const samplesText = samples
    .map((s, i) => `--- Message ${i + 1} ---\n${s.trim()}`)
    .join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 768,
    system: `Analyze these inbound messages from a single customer.
Return TWO things in a single JSON object — communication style AND operational facts.
Return ONLY valid JSON — no markdown, no explanation:
{
  "style": {
    "formality": "casual",
    "message_style": "brief",
    "language_notes": "1-2 short sentences on notable patterns — emoji use, dialect, abbreviations, punctuation habits, etc."
  },
  "facts": {
    "dietary": [],
    "mobility": [],
    "group_composition": null,
    "preferences": [],
    "occasions": []
  }
}

Style rules:
- formality: exactly one of "casual" or "formal"
- message_style: exactly one of "brief" or "chatty" or "detailed"

Facts rules — be conservative. Only include facts the customer ACTUALLY mentioned.
Do NOT invent or infer. Empty arrays / null are fine and preferred when nothing was said:
- dietary: short strings, e.g. ["vegetarian", "shellfish allergy"]. Only when explicitly stated.
- mobility: e.g. ["wheelchair user", "limited walking"]. Only when explicitly stated.
- group_composition: one sentence if a clear party composition was mentioned (e.g. "2 adults + 1 child age 5"), otherwise null.
- preferences: stated preferences only — "morning tours", "private over group", etc.
- occasions: noted occasions — "anniversary", "honeymoon", "bachelorette", etc.`,
    messages: [
      {
        role: 'user',
        content: `Analyze these customer messages and extract their style profile + operational facts:\n\n${samplesText}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(text) as ContactStyleAndFacts
}

/**
 * @deprecated Use extractContactStyleAndFacts which returns both style
 * and operational facts in a single call. Kept as a thin wrapper for
 * any older callers.
 */
export async function extractContactStyleProfile(
  samples: string[]
): Promise<ContactStyleProfile> {
  const result = await extractContactStyleAndFacts(samples)
  return result.style
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
    const { style, facts } = await extractContactStyleAndFacts(bodies)
    await supabase
      .from('contacts')
      .update({
        ai_contact_profile: style,
        ai_contact_facts: facts,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId)
    const factCount =
      (facts.dietary?.length ?? 0) +
      (facts.mobility?.length ?? 0) +
      (facts.group_composition ? 1 : 0) +
      (facts.preferences?.length ?? 0) +
      (facts.occasions?.length ?? 0)
    console.log(
      `[contact-profile] Refreshed profile for contact ${contactId} ` +
        `(count=${newCount}, samples=${bodies.length}, ${style.formality}/${style.message_style}, facts=${factCount})`
    )
  } catch (err) {
    console.error(`[contact-profile] Extraction failed for contact ${contactId}:`, err)
  }
}
