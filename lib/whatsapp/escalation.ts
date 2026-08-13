import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { clearStaleOutreachAutofill } from '@/lib/outreach-autofill'
import { enqueueEscalationPings } from './triggers'
import { extractTargetDate } from './urgency'
import { getDayAvailability } from '@/lib/calendar-availability'
import { buildOperatorBrief } from '@/lib/operator-brief'
import { extractInboundDigest } from '@/lib/inbound-digest-extract'
import { observeAttentionItem, SUBJECT_CONVERSATION } from '@/lib/owner-attention'
import { displayContactName, looksLikeEmailAddress } from './contact-display'
import type {
  CayeAutoReply,
  EscalationCategory,
  EscalationRouteTo,
} from '@/lib/caye-reply'
import type { ForcedTrigger } from '@/lib/forced-escalation'

export interface RecordEscalationInput {
  workspaceId: string
  conversationId: string | null
  contactName: string
  category: EscalationCategory
  routeTo: EscalationRouteTo
  customerFacingMessage: string
  internalContext: string
  /** Optional one-line operator-friendly summary for the WhatsApp ping.
   *  Forced escalations always supply one; LLM-driven escalate_to_team
   *  falls back to deriving from category + customerFacingMessage. */
  pingSummary?: string
  /** Raw inbound body the decision was generated from. Feeds
   *  buildOperatorBrief's structured-form parse (2026-08-07) — without it,
   *  a web-form booking (name/email/date/notes as labelled fields) can only
   *  be summarized as prose, losing the fields that actually decide the
   *  handoff (date, party size, the free-text note). Optional so existing
   *  callers keep working; omitting it just falls back to the prose brief. */
  body?: string
  /** Exact forced-escalation trigger, when this came from Layer 1
   *  (lib/forced-escalation.ts) rather than the LLM's escalate_to_team.
   *  Picks the right opening line + closing ask in buildOperatorBrief. */
  triggerHint?: ForcedTrigger
  /** When false, skip the human_agent_enabled update below — the
   *  escalation row and operator ping still go out, the conversation just
   *  doesn't enter the held queue. Defaults to true. See the matching
   *  doc comment on CayeAutoReply's escalate variant in caye-reply.ts. */
  holdConversation?: boolean
}

/**
 * Persist an escalation event + fan out operator pings. Called by every
 * channel webhook that observes `action: 'escalate'` from caye-reply.
 *
 * - Writes a caye_escalations row (used by the 6h follow-up cron).
 * - Marks the conversation `human_agent_enabled` so it surfaces in the inbox.
 * - Enqueues one outbound row per recipient phone via enqueueEscalationPings.
 *
 * Best-effort everywhere — a failure here must not block the customer-facing
 * reply that already went out on the wire.
 */
export async function recordEscalation(
  input: RecordEscalationInput
): Promise<{ escalationId: string | null }> {
  const supabase = createServiceClient()

  // Compose the operator brief (2026-08-07). Two passes: the first parses
  // the body for a structured date (form intake's DateISO field, the
  // strongest signal — same source extractCustomerRequestedDate trusts
  // elsewhere), then a calendar lookup on that date is folded into a
  // second pass so the brief answers "am I free that day?" before the
  // operator has to ask. Cheap either way — no LLM call, one Supabase
  // query only when a date was actually found.
  const briefInput = {
    trigger: input.triggerHint ?? null,
    contactName: input.contactName,
    body: input.body ?? '',
    alreadySent: input.customerFacingMessage,
    internalContext: input.internalContext,
  }
  const firstPass = buildOperatorBrief(briefInput)

  // Structured reading of prose inbounds (2026-08-12). Only for messages
  // that AREN'T a parseable intake form — a form is already rendered field
  // by field and needs no comprehension. targetDate is the discriminator:
  // buildOperatorBrief only ever sets it from the form path, so a null here
  // means we're on the prose path where the old code quoted the first 400
  // characters and shipped an owner a stranger's salutation.
  //
  // One extra LLM call per escalation. Escalations are low-frequency by
  // construction (they're the exception path), and the alternative is the
  // owner reading the raw email themselves — which is the cost this whole
  // product exists to remove.
  const digest =
    firstPass.targetDate === null && (input.body ?? '').trim()
      ? await extractInboundDigest({
          body: input.body ?? '',
          contactName: input.contactName,
          alreadySent: input.customerFacingMessage,
          workspaceId: input.workspaceId,
        })
      : null

  const availability = firstPass.targetDate
    ? await getDayAvailability(input.workspaceId, firstPass.targetDate)
    : null
  const brief =
    availability || digest
      ? buildOperatorBrief({
          ...briefInput,
          digest,
          ...(availability
            ? {
                availability: {
                  dateISO: availability.dateISO,
                  bookingCount: availability.bookings.length,
                },
              }
            : {}),
        })
      : firstPass

  // Single source of truth for the date this escalation is about — prefer
  // the structured form field (brief.targetDate) over prose-scraping
  // internalContext/customerFacingMessage, and use the SAME value for both
  // caye_escalations.target_date and unified_conversations.target_date so
  // the two tables can't disagree about when a hold's underlying date has
  // passed (see the fix below — unified_conversations.target_date used to
  // never get set on the escalate path at all, only on plain 'hold'
  // decisions, so get_held_queue's date_passed flag was silently blind for
  // every escalated booking).
  const resolvedTargetDate =
    brief.targetDate ?? extractTargetDate(`${input.internalContext} ${input.customerFacingMessage}`)
      ?.toISOString()
      .slice(0, 10) ?? null

  // Guard against piling on: if this conversation — or another open
  // conversation belonging to the SAME contact — already has an open
  // escalation (not yet resolved, not expired), don't create a second row
  // or fire a second ping. Confirmed live: a customer (Marissa McGourthy)
  // followed up 3 times about one unresolved fishing-charter ask, and
  // because generateCayeAutoReply has no visibility into prior
  // escalations (fetchConversationHistory filters out the internal
  // escalation marker message), the LLM re-escalated fresh each time —
  // 3 separate caye_escalations rows, each spinning up its own daily
  // "still waiting" nag, for what the operator experienced as one
  // question. Still update the conversation's hold reason + drop an
  // internal audit note so the dashboard reflects the latest ask, just
  // without a second WhatsApp ping.
  //
  // Widened 2026-08-13: the original guard only matched the literal
  // conversationId, which a contact-identity gap could defeat outright —
  // Karin Roberts followed up about one deposit invoice through what the
  // system saw as separate unified_conversations rows (fixed for new
  // inbound traffic in 753828e, but conversations that already forked
  // before that fix still exist), and each one independently escalated and
  // pinged. Resolving the contact behind conversationId and checking every
  // other open conversation for that same contact closes the gap for those
  // pre-existing forks too, not just future ones.
  if (input.conversationId) {
    let conversationIds = [input.conversationId]
    const { data: thisConv } = await supabase
      .from('unified_conversations')
      .select('contact_id')
      .eq('id', input.conversationId)
      .maybeSingle()
    const contactId = (thisConv as { contact_id: string | null } | null)?.contact_id ?? null
    if (contactId) {
      // contact_id alone is sufficient scoping — a contacts row belongs to
      // exactly one workspace (contacts.customer_id), so every conversation
      // referencing it is already implicitly workspace-scoped. unified_
      // conversations has no workspace_id column of its own (it's reached
      // via connected_account_id instead), so don't add one here.
      const { data: siblingConvs } = await supabase
        .from('unified_conversations')
        .select('id')
        .eq('contact_id', contactId)
      if (siblingConvs?.length) {
        conversationIds = Array.from(
          new Set([input.conversationId, ...siblingConvs.map((c) => c.id as string)])
        )
      }
    }

    const { data: existing } = await supabase
      .from('caye_escalations')
      .select('id')
      .in('conversation_id', conversationIds)
      .is('owner_responded_at', null)
      .is('expired_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existing) {
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_reason: `Escalation (${input.category}): ${input.internalContext.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
          human_agent_marked_at: new Date().toISOString(),
          target_date: resolvedTargetDate,
        })
        .eq('id', input.conversationId)
      await supabase.from('unified_messages').insert({
        conversation_id: input.conversationId,
        channel_message_id: null,
        sender_type: 'business',
        content: `[Caye escalation follow-up — already open, no new ping] ${input.internalContext}`,
        message_type: 'text',
        sent_at: new Date().toISOString(),
        status: 'sent',
        is_internal: true,
        metadata: {
          generated_by: 'caye',
          escalation_id: existing.id,
          category: input.category,
          route_to: input.routeTo,
          duplicate_of_open_escalation: true,
        },
      })
      return { escalationId: existing.id }
    }
  }

  // Derive a fallback ping summary for LLM-driven escalations that didn't
  // supply one. internalContext is already written as operator-ready prose
  // by the escalate_to_team tool contract (a 2-5 sentence handoff note
  // ending in a concrete yes/no proposal — see lib/caye-reply.ts) so it can
  // be used as-is; no category-label prefix ("Policy call —", "Knowledge
  // gap —") gets prepended, since that's internal taxonomy jargon, not
  // something an operator needs to read at a glance. Caps at 200 chars.
  //
  // Persisted (not just used for the immediate ping) so the escalation-
  // followup cron can re-ping days later with the same clean text instead
  // of reconstructing one from internal_context on every read.
  const pingSummary =
    input.pingSummary ?? input.internalContext.replace(/\s+/g, ' ').trim().slice(0, 200)

  const { data, error } = await supabase
    .from('caye_escalations')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      category: input.category,
      route_to: input.routeTo,
      customer_facing_message: input.customerFacingMessage,
      internal_context: input.internalContext,
      ping_summary: pingSummary,
      // Best-effort target date, so the follow-up cron can stop nudging
      // once the underlying window has passed (confirmed live: a "July 4th
      // booking" escalation kept getting a daily "still waiting" ping days
      // after July 4th was gone). resolvedTargetDate prefers the structured
      // form field over prose-scraping — see the comment where it's built.
      target_date: resolvedTargetDate,
      brief: brief.brief,
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[escalation] insert failed:', error)
    return { escalationId: null }
  }

  if (input.conversationId) {
    // See lib/outreach-autofill.ts — clear any stale outreach_followup
    // autofill draft before marking this (unrelated) escalation, or the
    // dashboard compose box keeps surfacing the old templated nudge.
    await clearStaleOutreachAutofill(input.conversationId)
    // holdConversation: false (2026-08-07, Layer 2 self-review) skips this
    // — the escalation row + ping below still fire, but a reply Caye
    // already sent to a customer who isn't blocked on anything shouldn't
    // enter the held queue. See the doc comment on CayeAutoReply's
    // escalate variant for the incident this fixes.
    if (input.holdConversation !== false) {
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: true,
          human_agent_reason: `Escalation (${input.category}): ${pingSummary.slice(0, 120)}`,
          human_agent_marked_at: new Date().toISOString(),
          target_date: resolvedTargetDate,
        })
        .eq('id', input.conversationId)
    }
    await supabase.from('unified_messages').insert({
      conversation_id: input.conversationId,
      channel_message_id: null,
      sender_type: 'business',
      content: `[Caye escalation — ${input.category} → ${input.routeTo}] ${input.internalContext}`,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: {
        generated_by: 'caye',
        escalation_id: data.id,
        category: input.category,
        route_to: input.routeTo,
      },
    })
  }

  // Register with the shared attention ledger BEFORE the ping goes out, so
  // the outbound worker's markAttentionNotified has a row to stamp and the
  // morning digest can never describe this as "nothing new" (2026-08-12).
  //
  // Keyed by CONVERSATION, not by escalation id — see SUBJECT_CONVERSATION.
  // lib/owner-attention-sync.ts also sees this thread (as a hold) and must
  // land on the same row, or one thread becomes two lines in the briefing.
  // Escalating writes here rather than leaving it to the sync because this
  // is the only moment the composed digest exists.
  //
  // Falls back to the escalation id only for a conversation-less escalation,
  // which has no thread for the sync to find and so cannot collide.
  await observeAttentionItem({
    workspaceId: input.workspaceId,
    subjectType: input.conversationId ? SUBJECT_CONVERSATION : 'escalation',
    subjectId: input.conversationId ?? data.id,
    conversationId: input.conversationId,
    title: `${input.contactName} — ${pingSummary.slice(0, 80)}`,
    priority: 'decision',
    nextAction: 'Waiting on your call',
    digest,
    // Caye escalated specifically because she couldn't handle this herself
    // — feeds the notification gate's reminder cadence (blocking items get
    // the shorter threshold) and its "rising autonomy resolves rather than
    // pings" rule (brief §9), even though this create path doesn't itself
    // route through the gate (see the dedupe guard above for why: a
    // genuinely new escalation always sends, quiet-hours/cooldown don't
    // apply to it by design, same as enqueueEscalationPings already does).
    blockedOnOperator: true,
    resolvableAutonomously: false,
    // What re-earns attention: a different ask, a different date, a
    // different category. Not the clock — an item that has merely aged is
    // handled by the unchanged bucket, not by a fresh fingerprint.
    fingerprintParts: [input.category, resolvedTargetDate, pingSummary],
  })

  enqueueEscalationPings({
    workspaceId: input.workspaceId,
    escalationId: data.id,
    conversationId: input.conversationId,
    contactName: input.contactName,
    category: input.category,
    routeTo: input.routeTo,
    suggestedReply: input.customerFacingMessage,
    internalContext: input.internalContext,
    pingSummary,
    brief: brief.brief,
    oneLine: brief.oneLine,
  }).catch((err) => console.error('[escalation] enqueueEscalationPings failed:', err))

  return { escalationId: data.id }
}

/**
 * Webhook glue: when caye-reply returns an `escalate` decision, persist the
 * escalation + queue operator pings, then collapse to a plain `reply`
 * decision so the rest of the webhook's send/store path runs unchanged.
 *
 * Returns the original decision when it isn't an escalation.
 */
export async function applyEscalation(
  decision: CayeAutoReply,
  meta: {
    workspaceId: string
    conversationId: string | null
    contactName: string
    /** Raw inbound body the decision was generated from — see
     *  RecordEscalationInput.body. Every call site already has this (it's
     *  what was passed to generateCayeAutoReply), so pass it through rather
     *  than re-deriving from decision.internalContext, which is prose Caye
     *  wrote about the inbound, not the inbound itself. */
    body?: string
  }
): Promise<Exclude<CayeAutoReply, { action: 'escalate' }>> {
  if (decision.action !== 'escalate') return decision

  // Every call site builds contactName as `senderName || senderEmail`, so a
  // sender with no display name arrives here as a bare address — and the
  // owner's ping reads "tuzi needs your call" about a guest she knows as
  // Delysia Weeks (2026-08-09). Recover the thread's stored customer_name
  // before that reaches a phone; fall back to a generic label rather than an
  // inbox handle. Centralised here so all eight call sites are covered at
  // once. See lib/whatsapp/contact-display.ts.
  const contactName = looksLikeEmailAddress(meta.contactName)
    ? displayContactName(
        await lookupConversationName(meta.conversationId),
        // Deliberately not meta.contactName — it's the address we just rejected.
        null
      )
    : displayContactName(meta.contactName)

  await recordEscalation({
    workspaceId: meta.workspaceId,
    conversationId: meta.conversationId,
    contactName,
    category: decision.category,
    routeTo: decision.routeTo,
    customerFacingMessage: decision.content,
    internalContext: decision.internalContext,
    pingSummary: decision.pingSummary,
    body: meta.body,
    triggerHint: decision.triggerHint,
    holdConversation: decision.holdConversation,
  })

  return { action: 'reply', content: decision.content }
}

/** The thread's stored customer_name, or null. Used to recover a real name
 *  when the call site could only supply an email address. */
async function lookupConversationName(conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null
  const { data } = await createServiceClient()
    .from('unified_conversations')
    .select('customer_name')
    .eq('id', conversationId)
    .maybeSingle()
  return (data as { customer_name: string | null } | null)?.customer_name ?? null
}

// Last-resort fallback only, for legacy escalation rows with no persisted
// ping_summary at all. Plain language on purpose — this can still reach an
// operator's WhatsApp directly, not just an internal log.
export function labelForCategory(category: EscalationCategory): string {
  switch (category) {
    case 'gap':
      return "Something I couldn't do myself"
    case 'policy':
      return 'A call I need you to make'
    case 'knowledge':
      return "A question I don't know the answer to"
    case 'sensitive':
      return 'Something private or sensitive'
  }
}
