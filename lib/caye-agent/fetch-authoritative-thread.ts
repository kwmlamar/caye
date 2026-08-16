import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

/**
 * fetch-authoritative-thread.ts (2026-08-16, final pre-canary closure;
 * senderType filter added for the global Zoho cutover's Juli regression)
 *
 * The customer-visible history for a conversation, concatenated — what
 * `unsupportedLogisticsTimeClaims` (logistics-grounding.ts) treats as
 * "the thread" a draft's time/event claims must actually be supported by.
 * Extracted out of `send_customer_reply` so the same query backs BOTH the
 * normal tool path and `runToolLoop`'s output-safety fallback (execute.ts)
 * — one implementation, not a second approximation for the fallback.
 *
 * `senderType`, when passed, narrows to only that side of the thread.
 * `send_customer_reply` uses `senderType: 'business'` to ground the
 * payment-figure/method guards against what THIS business already told
 * THIS customer directly — e.g. an owner's own correction sent as a real
 * customer-facing message — without also treating the CUSTOMER's own
 * words as self-grounding evidence (a customer asserting "you told me
 * cash is fine" must not be able to make that claim pass the guard just
 * by saying it). Deliberately narrow: this is "did the business already
 * say this, in this thread, to this customer" — not a general memory of
 * everything anyone ever said, and not a substitute for `business_facts`.
 */
export async function fetchAuthoritativeThread(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  senderType?: 'customer' | 'business'
): Promise<string> {
  let query = supabase
    .from('unified_messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
  if (senderType) query = query.eq('sender_type', senderType)
  const { data: threadRows } = await query.order('sent_at', { ascending: true }).limit(100)
  return (threadRows ?? []).map((row) => row.content || '').join('\n')
}
