import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getHeldSummary } from '@/lib/hold-kinds'
import type { Tool } from '../types'

export const getHeldQueue: Tool<Record<string, never>> = {
  name: 'get_held_queue',
  description:
    "Get the current held items needing the operator's call. Each item is a customer thread Caye paused because she wasn't confident enough to reply autonomously. Drafted cold outreach awaiting batch approval is NOT included — it appears only as `queued_outreach_drafts`, a count. Those are a work queue the operator processes when it suits them (via get_pending_quotes and send_outreach_batch); nobody is waiting on them, so never describe them as needing attention or fold them into the held count. Use this when the operator asks 'anything need my call?' / 'anyone held?' / 'what's pending?'. Each item carries has_open_escalation — true means it already has its own daily nag cadence via escalation-followup, so briefings/recaps should NOT re-describe it in detail or re-propose an action (that's duplicate noise the operator already saw); just fold escalated items into a one-line count. Only items with has_open_escalation=false are new enough to warrant calling out by name. Each item also carries date_passed — true means the customer referenced a specific calendar date (e.g. a booking date) that has already gone by with no response sent. When narrating these, say so plainly (e.g. 'that date's already passed') instead of repeating the original ask as if it were still live — don't imply the date is still actionable.\n\n`reason` is the full operator brief for escalated items (calendar check, the customer's own words, what they were already told, a suggested question to answer) — relay it in substance, don't re-summarize it down to a fragment. For a plain low-confidence hold (no escalation) it's still just a short internal note, same as before.\n\nIMPORTANT EVIDENCE SCOPE: this tool proves the held-customer-thread subset only. It does NOT prove that there are no other unresolved attention items, approvals, assignments, inbox work, bookings, leads, or operational problems. A zero held count must be reported as 'no held customer threads', never 'nothing needs attention' unless other relevant sources were also checked.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()

    // Queue holds (drafted cold outreach awaiting batch approval) are
    // excluded from `rows` here, not just filtered at display time — see
    // lib/hold-kinds.ts. `queued` is reported separately below.
    const { attention: rows, queuedCount: queued } = await getHeldSummary(supabase, ctx.workspaceId)
    const conversationIds = rows.map((r) => r.id)

    // Cross-reference caye_escalations for two things: (1) has_open_escalation
    // so briefings/recaps can tell "brand new hold" from "already being nagged
    // daily via escalation-followup" — without this, get_held_queue re-surfaces
    // the same names the followup cron is separately chasing, and the operator
    // sees the same item described twice through two unrelated channels the
    // same day; (2) the composed brief itself (2026-08-07) — before this, Caye
    // only ever saw human_agent_reason, a 100-120 char slice of the raw
    // inbound that dies mid-field on a web-form submission with no ellipsis
    // (a booking's date and its only free-text note — the thing that actually
    // decides whether the tour can run — routinely fell past the cutoff). The
    // brief carries the calendar check, the customer's actual words, and what
    // they were already told; internal_context is the next-best fallback for
    // escalations that predate the brief column; human_agent_reason is the
    // last resort for plain low-confidence holds that were never escalations
    // at all and so have no caye_escalations row.
    let openEscalationConvIds = new Set<string>()
    const briefByConvId = new Map<string, string>()
    if (conversationIds.length > 0) {
      const { data: escalations } = await supabase
        .from('caye_escalations')
        .select('conversation_id, brief, internal_context, owner_responded_at, expired_at, created_at')
        .in('conversation_id', conversationIds)
        .is('owner_responded_at', null)
        .is('expired_at', null)
        .order('created_at', { ascending: false })
      for (const e of (escalations ?? []) as Array<{
        conversation_id: string | null
        brief: string | null
        internal_context: string | null
      }>) {
        if (!e.conversation_id) continue
        openEscalationConvIds.add(e.conversation_id)
        // Rows arrive newest-first; keep only the first (most recent) brief
        // per conversation.
        if (!briefByConvId.has(e.conversation_id)) {
          const text = e.brief ?? e.internal_context
          if (text) briefByConvId.set(e.conversation_id, text)
        }
      }
    }

    const todayISO = new Date().toISOString().slice(0, 10)

    return {
      ok: true,
      data: {
        evidence_scope: {
          source_tool: 'get_held_queue',
          request_id: ctx.requestId,
          workspace_id: ctx.workspaceId,
          subset: 'held_customer_threads',
          complete_for_subset: true,
          global_attention_complete: false,
          excludes: [
            'queued_outreach_drafts',
            'other_attention_sources',
            'approvals',
            'assignments',
            'bookings',
            'leads',
          ],
          observed_at: new Date().toISOString(),
        },
        items: rows.map((r) => ({
          conversation_id: r.id,
          customer: r.customer_name || r.customer_id || 'a customer',
          channel: r.channel_type,
          reason: briefByConvId.get(r.id) ?? r.human_agent_reason,
          preview: r.last_message_preview,
          held_at: r.human_agent_marked_at,
          has_open_escalation: openEscalationConvIds.has(r.id),
          date_passed: !!r.target_date && r.target_date < todayISO,
        })),
        count: rows.length,
        // Drafted cold outreach waiting on batch approval. Deliberately NOT
        // in `items` — nobody is waiting on these and they are processed in
        // one sitting via get_pending_quotes + send_outreach_batch. Mention
        // the number if it's useful; never present it as pending attention.
        queued_outreach_drafts: queued,
      },
    }
  },
}
