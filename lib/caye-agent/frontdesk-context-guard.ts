import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

type Db = ReturnType<typeof createServiceClient>

type FollowupKind = 'send' | 'follow_up'

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const NEGATION_RE = /\b(?:do not|don't|does not|doesn't|cannot|can't|never|won't|will not)\b/i

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  return match ? value.trim().toLowerCase() : null
}

function followupKind(sentence: string): FollowupKind | null {
  if (NEGATION_RE.test(sentence)) return null
  const futureActor = /\b(?:we|i)\s*(?:will|'ll)\b/i.test(sentence)
  if (!futureActor) return null

  if (
    /\b(?:send|forward|share|email)\b/i.test(sentence) ||
    /\b(?:get|have)\b[^.!?]{0,80}\b(?:sent|forwarded|shared|emailed)\b/i.test(sentence)
  ) {
    return 'send'
  }
  if (/\b(?:follow\s*up|circle\s+back|reach\s+out|contact)\b/i.test(sentence)) {
    return 'follow_up'
  }
  return null
}

function groundingSupports(kind: FollowupKind, groundingText: string): boolean {
  return sentences(groundingText).some((sentence) => {
    if (NEGATION_RE.test(sentence)) return false
    if (kind === 'send') {
      return /\b(?:send|sent|forward|forwarded|share|shared|email|emailed)\b/i.test(sentence)
    }
    return /\b(?:follow\s*up|followed\s*up|circle\s+back|reach\s+out|contact)\b/i.test(sentence)
  })
}

/**
 * CAY-110: a customer already writing to the business on a channel must not
 * be told to initiate that same channel again. This is a pure decision layer
 * so the invariant can be regression-tested without a database.
 */
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

/**
 * Future work is a consequential claim. Polite phrasing does not create an
 * employee, task, or execution plan. Require authoritative grounding for the
 * action Caye says the business will perform later.
 */
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
    return {
      code: 'REDUNDANT_CURRENT_CHANNEL_INSTRUCTION',
      message: redundant,
    }
  }

  const unsupportedFuture = detectUnsupportedFutureActionCommitment(
    args.body,
    args.groundingText
  )
  if (unsupportedFuture) {
    return {
      code: 'UNSUPPORTED_FUTURE_ACTION_COMMITMENT',
      message: unsupportedFuture,
    }
  }

  return null
}
