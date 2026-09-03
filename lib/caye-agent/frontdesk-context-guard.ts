import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

type Db = ReturnType<typeof createServiceClient>
type FollowupKind = 'send' | 'follow_up'

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const NEGATION_RE = /\b(?:do not|don't|does not|doesn't|cannot|can't|never|won't|will not)\b/i
const TRANSFERABLE_ARTIFACT_RE = /\b(?:photo|picture|image|file|document|details?|information|info|link|copy|receipt|invoice|attachment|confirmation|it|that)\b/i

/**
 * An abbreviation whose trailing period does NOT end a sentence.
 *
 * Without this, `sentences()` cut "Mrs. Max will be sending your invoice"
 * into "Mrs." and "Max will be sending your invoice" -- and `hasFutureActor`
 * matches an honorific followed by a name and `will`, so the half it was
 * given no longer had the "Mrs. " it needed. The guard returned null on the
 * exact string the 2026-08-20 incident is named after, which is the string
 * `hasFutureActor` was widened to catch in the first place.
 */
const NON_TERMINAL_ABBREVIATION_RE = /\b(?:mr|mrs|ms|dr|prof|rev|hon|sr|jr|st)\.$/i

function sentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Re-join anything the split tore off an honorific. Done as a repair pass
  // rather than a cleverer split regex because titles chain -- "Mr. and Mrs.
  // Christiansen will..." breaks twice -- and a loop handles that without the
  // regex having to.
  const joined: string[] = []
  for (const part of parts) {
    const previous = joined[joined.length - 1]
    if (previous !== undefined && NON_TERMINAL_ABBREVIATION_RE.test(previous)) {
      joined[joined.length - 1] = `${previous} ${part}`
    } else {
      joined.push(part)
    }
  }
  return joined
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null
}

function sentencePromisesTransfer(sentence: string): boolean {
  if (/\b(?:send|forward|email)\b/i.test(sentence)) return true
  if (
    /\bshare\b[^.!?]{0,80}\b(?:photo|picture|image|file|document|details?|information|info|link|copy|receipt|invoice|attachment|confirmation|it|that)\b/i.test(sentence)
  ) {
    return true
  }
  return /\b(?:get|have)\b[^.!?]{0,80}\b(?:sent|forwarded|emailed|shared)\b/i.test(sentence) && TRANSFERABLE_ARTIFACT_RE.test(sentence)
}

function hasFutureActor(sentence: string): boolean {
  // Do not limit this to first person. Production incident 2026-08-20:
  // "Mrs. Max will be sending your invoice shortly" bypassed the old
  // `(we|i) will` check even though it is the same unsupported promise.
  return /\b(?:we|i|our\s+team|the\s+owner|mr\.?\s+[a-z][\w'-]*|mrs\.?\s+[a-z][\w'-]*|ms\.?\s+[a-z][\w'-]*)\s*(?:will|'ll)\b/i.test(sentence)
}

function followupKind(sentence: string): FollowupKind | null {
  if (NEGATION_RE.test(sentence)) return null
  if (!hasFutureActor(sentence)) return null
  if (sentencePromisesTransfer(sentence)) return 'send'
  if (/\b(?:follow\s*up|circle\s+back|reach\s+out|contact|be\s+in\s+touch|get\s+back\s+to\s+you)\b/i.test(sentence)) {
    return 'follow_up'
  }
  return null
}

function groundingSupports(kind: FollowupKind, groundingText: string): boolean {
  return sentences(groundingText).some((sentence) => {
    if (NEGATION_RE.test(sentence)) return false
    if (kind === 'send') return sentencePromisesTransfer(sentence)
    return /\b(?:follow\s*up|followed\s*up|circle\s+back|reach\s+out|contact|be\s+in\s+touch|get\s+back\s+to\s+you)\b/i.test(sentence)
  })
}

export function detectRedundantCurrentChannelInstruction(args: {
  body: string
  channelType: string | null
  currentBusinessEmails?: string[]
}): string | null {
  const channel = (args.channelType ?? '').toLowerCase()
  const currentEmails = new Set(
    (args.currentBusinessEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)
  )

  for (const sentence of sentences(args.body)) {
    if (channel === 'email') {
      if (/\b(?:email\s+us|send\s+us\s+an?\s+email)\b/i.test(sentence)) {
        return 'customer is already communicating with the business by email'
      }
      const directive = /\b(?:reach\s+out|contact|email|write)\b/i.test(sentence)
      if (directive) {
        const addresses = sentence.match(EMAIL_RE) ?? []
        const repeated = addresses.find((address) => currentEmails.has(address.toLowerCase()))
        if (repeated) {
          return `customer is already on this email channel; redirecting them to ${repeated} is redundant`
        }
      }
    }

    if (
      channel === 'whatsapp' &&
      /\b(?:whatsapp\s+us|message\s+us\s+on\s+whatsapp|reach\s+out\s+(?:to\s+us\s+)?on\s+whatsapp)\b/i.test(sentence)
    ) {
      return 'customer is already communicating with the business on WhatsApp'
    }
  }
  return null
}

export function detectUnsupportedFutureActionCommitment(
  body: string,
  groundingText: string
): string | null {
  for (const sentence of sentences(body)) {
    const kind = followupKind(sentence)
    if (!kind) continue
    if (!groundingSupports(kind, groundingText)) {
      return `unsupported future ${kind === 'send' ? 'send/share' : 'follow-up'} commitment ("${sentence}")`
    }
  }
  return null
}

async function currentConversationChannelContext(
  db: Db,
  conversationId: string
): Promise<{ channelType: string | null; businessEmails: string[] }> {
  const { data: conv } = await db
    .from('unified_conversations')
    .select('channel_type, connected_account_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conv) return { channelType: null, businessEmails: [] }

  const emails = new Set<string>()
  if (conv.connected_account_id) {
    const [{ data: profile }, { data: account }] = await Promise.all([
      db
        .from('business_profiles')
        .select('contact_email')
        .eq('connected_account_id', conv.connected_account_id)
        .maybeSingle(),
      db
        .from('connected_accounts')
        .select('channel_username, channel_account_name, metadata')
        .eq('id', conv.connected_account_id)
        .maybeSingle(),
    ])

    const candidates: unknown[] = [
      profile?.contact_email,
      account?.channel_username,
      account?.channel_account_name,
      (account?.metadata as Record<string, unknown> | null)?.email,
      (account?.metadata as Record<string, unknown> | null)?.email_address,
    ]
    for (const candidate of candidates) {
      const email = normalizeEmail(candidate)
      if (email) emails.add(email)
    }
  }

  return {
    channelType: (conv.channel_type as string | null) ?? null,
    businessEmails: [...emails],
  }
}

export async function validateFrontDeskContext(args: {
  db: Db
  conversationId: string
  body: string
  groundingText: string
}): Promise<{ code: string; message: string } | null> {
  const context = await currentConversationChannelContext(args.db, args.conversationId)
  const redundant = detectRedundantCurrentChannelInstruction({
    body: args.body,
    channelType: context.channelType,
    currentBusinessEmails: context.businessEmails,
  })
  if (redundant) {
    return { code: 'REDUNDANT_CURRENT_CHANNEL_INSTRUCTION', message: redundant }
  }

  const unsupportedFuture = detectUnsupportedFutureActionCommitment(
    args.body,
    args.groundingText
  )
  if (unsupportedFuture) {
    return { code: 'UNSUPPORTED_FUTURE_ACTION_COMMITMENT', message: unsupportedFuture }
  }

  return null
}
