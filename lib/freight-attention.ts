import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { observeAttentionItem, type AttentionPriority } from '@/lib/owner-attention'
import { freightReferenceLabel } from '@/lib/freight/types'
import type { FreightWorkflowRecord } from '@/lib/freight/workflow'

/**
 * Freight document requests -> owner attention.
 *
 * THE GAP THIS CLOSES
 *
 * ODS's audit found the single highest-volume repetitive job in the business
 * is Wallace personally emailing a commercial invoice back to a freight
 * forwarder — at least 15 times in a 60-day window. Detection for this
 * already runs every five minutes: a cron reads Gmail, ingests attachments,
 * and `app/api/founder/freight-workflow/route.ts` detects the request and
 * writes a `FreightWorkflowRecord` onto `unified_conversations.metadata.
 * freight_workflow`. None of that reaches Wallace — it lands in a dashboard
 * tab (`FreightReviewInbox`) nobody opens. That is the exact failure the
 * audit describes throughout: correct detection reported somewhere nobody
 * reads. This module is the missing wire, following the same pattern
 * `lib/domain-attention.ts` established for construction-domain changes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not detect a freight request, rank purchase evidence, or generate
 * a document — `app/api/founder/freight-workflow/route.ts` already owns all
 * of that, with its own idempotency (the record is keyed and persisted once
 * per conversation) and its own consequential-action architecture (a send
 * requires `claimConversationExecution` and explicit owner approval). This
 * module only reads the workflow record that process already wrote, decides
 * whether its current state is worth the owner's attention, and hands that
 * decision to the ledger that owns notification state. It never sends
 * anything, never generates a document, and never claims one was sent.
 */

/**
 * `subject_type` is free text with no CHECK constraint (see
 * `lib/domain-attention.ts`'s `SUBJECT_CONSTRUCTION_CHANGE` for the same
 * reasoning) — declared once here so no second producer can key freight
 * requests differently.
 */
export const SUBJECT_FREIGHT_REQUEST = 'freight_request'

/**
 * `subjectId` = the conversation id, not the request/unified-message id.
 *
 * A freight request lives entirely inside one Gmail conversation's
 * `metadata.freight_workflow` — `analyze()` in the route short-circuits to
 * the existing record whenever `existing.conversationId === conv.id`, and
 * every mutation (`generate`, `approve_send`) is claimed and executed
 * against `conversationId`, not the originating message. Keying attention on
 * the conversation id keeps one ledger row per request exactly the way one
 * dashboard entry exists per request, and lets a future notifier link straight
 * back to the thread the owner would act in.
 */
export type FreightAttentionSubjectId = string

/** One open freight workflow, as read off its owning conversation. */
export interface FreightAttentionConversation {
  conversationId: string
  workflow: FreightWorkflowRecord
}

/** The statuses this module ever raises attention for. `SENT` is terminal —
 *  the job is done, and a done job is not something to keep telling Wallace
 *  about. */
export type FreightAttentionStatus = Exclude<FreightWorkflowRecord['status'], 'SENT'>

export interface FreightAttentionRule {
  priority: AttentionPriority
  /** Short state description used in the title, before the reference. */
  summary: string
  /**
   * What the owner is asked to do, given the reference's already-resolved
   * label. Takes the label as a parameter (rather than the raw
   * `FreightReference`) so this table never has to branch on `kind` itself —
   * `freightReferenceLabel()` stays the single place that knows how a dock
   * receipt differs from a warehouse number.
   */
  nextAction: (referenceLabel: string) => string
}

/**
 * The freight domain's policy on what a workflow state is worth.
 *
 * Priority reflects what is actually blocked, not how the request looks in
 * isolation:
 *
 *   - MATCH_FOUND / READY_FOR_APPROVAL ("ready to send"): Caye already has
 *     everything she needs — a confident purchase match, and, once
 *     generated, a drafted reply with the document attached. Closing this is
 *     a single word from Wallace ("send it"), so it is a `decision`: real
 *     stakes (a message goes out in his name), minimal owner effort.
 *   - AMBIGUOUS: more than one purchase record scores close enough that
 *     picking automatically would risk attaching the wrong invoice — worse
 *     than sending nothing. Nothing is at risk of being lost by waiting, it
 *     just needs a quick human pick when convenient, so `awareness` fits:
 *     worth a line, not a page.
 *   - NO_MATCH: nothing else in the business is watching this. There is no
 *     draft, no candidate, nothing that will surface again on its own —
 *     exactly the shape of the failure this whole module exists to close.
 *     Without the owner going to find the source document himself, this
 *     specific forwarder request silently never gets answered. `critical`
 *     is warranted because the cost of staying silent here is total: the
 *     job just does not happen.
 *
 * A policy table, not a heuristic, for the same reason
 * `CONSTRUCTION_ATTENTION_RULES` is one: "how loudly should this be raised"
 * is a business decision that must be reviewable in one place.
 */
export const FREIGHT_ATTENTION_RULES: Record<FreightAttentionStatus, FreightAttentionRule> = {
  MATCH_FOUND: {
    priority: 'decision',
    summary: 'confident match found, ready to prepare',
    nextAction: (label) =>
      `Caye found a confident purchase match for ${label} — say the word and she will prepare and send the document, or review it yourself first.`,
  },
  READY_FOR_APPROVAL: {
    priority: 'decision',
    summary: 'document ready to send',
    nextAction: (label) => `The freight document for ${label} is ready — approve it and Caye will send it to the forwarder.`,
  },
  AMBIGUOUS: {
    priority: 'awareness',
    summary: 'more than one possible match',
    nextAction: (label) => `More than one purchase record could match ${label} — tell Caye which one is right before anything goes out.`,
  },
  NO_MATCH: {
    priority: 'critical',
    summary: 'no matching purchase record found',
    nextAction: (label) => `No purchase record matches ${label} yet — find the invoice or receipt so Caye can prepare the document.`,
  },
}

/** The rule for a workflow's current status, or `undefined` for a status
 *  this table has no opinion about (including the terminal `SENT`, and any
 *  future status this producer has not been taught yet). */
export function ruleFor(status: FreightWorkflowRecord['status']): FreightAttentionRule | undefined {
  return FREIGHT_ATTENTION_RULES[status as FreightAttentionStatus]
}

/**
 * The reference label the owner should see.
 *
 * Always goes through `freightReferenceLabel()` — never re-implemented or
 * branched on `reference.kind` here — so "Dock Receipt 10432233" and
 * "Warehouse 188052" stay correct without this module knowing which
 * forwarders exist. The only case this function adds anything for is a
 * `null` reference (freight language detected without an extractable
 * number): `freightReferenceLabel(null)` returns the literal string
 * `"UNKNOWN"`, which reads as a bug to an owner rather than "we don't have a
 * number for this one yet." Substituting only the null case keeps that
 * substitution independent of `kind` — every non-null reference, of any
 * kind, still passes through unmodified.
 */
export function referenceLabelFor(workflow: FreightWorkflowRecord): string {
  const label = freightReferenceLabel(workflow.request.reference)
  return label === 'UNKNOWN' ? 'an unidentified reference' : label
}

/** "Warehouse 188052 — document ready to send" */
export function titleFor(workflow: FreightWorkflowRecord): string {
  const label = referenceLabelFor(workflow)
  const rule = ruleFor(workflow.status)
  return rule ? `${label} — ${rule.summary}` : `${label} — freight document request`
}

/** `null` only for a status this table has no rule for (see `ruleFor`).
 *  Never asserts the document was sent — every rule's wording asks for
 *  approval or evidence, and stops there; whether it actually went out is
 *  `approveAndSend`'s fact to report, not this sweep's to guess. */
export function nextActionFor(workflow: FreightWorkflowRecord): string | null {
  const rule = ruleFor(workflow.status)
  return rule ? rule.nextAction(referenceLabelFor(workflow)) : null
}

/**
 * Only the fields whose change should re-earn the owner's attention: the
 * workflow status, and whether a document has been generated yet.
 *
 * Deliberately NOT the age of the request and NOT a timestamp of any kind.
 * A freight request that is still `NO_MATCH` five sweeps from now is exactly
 * as `NO_MATCH` as it was on the first sweep — including a clock reading in
 * the fingerprint would make every open request re-earn attention on every
 * five-minute pass, and Wallace would learn to ignore the channel within a
 * day. That is precisely the failure `caye_owner_attention`'s fingerprint
 * exists to prevent (see `lib/owner-attention.ts`'s header). Only an actual
 * state transition — a better match found, ambiguity resolved, a document
 * generated, approved, or sent — should make this line reappear as new.
 */
export function fingerprintPartsFor(workflow: FreightWorkflowRecord): unknown[] {
  return [workflow.status, Boolean(workflow.generatedArtifactId)]
}

export interface FreightAttentionDeps {
  loadOpenRequests: (workspaceId: string) => Promise<FreightAttentionConversation[]>
  observe: typeof observeAttentionItem
}

export interface FreightAttentionResult {
  considered: number
  raised: number
  skipped: {
    /** Reached SENT between load and processing, or the loader returned a
     *  stale row — a sweep must never trust a cached read as the last word. */
    alreadySent: number
    /** The workflow record was missing required fields. Defensive only:
     *  the route always writes a complete `FreightWorkflowRecord`. */
    malformed: number
    /** A status this table has no rule for yet — see `ruleFor`. */
    unknownStatus: number
  }
}

async function loadOpenFreightRequestsFromDb(workspaceId: string): Promise<FreightAttentionConversation[]> {
  const supabase = createServiceClient()
  // Mirrors the query `app/api/founder/freight-workflow/route.ts`'s GET
  // (no conversationId) already uses to list the dashboard's own inbox:
  // Gmail conversations owned by this workspace's connected account.
  // Filtering `metadata.freight_workflow` in JS rather than via a nested
  // PostgREST `metadata->freight_workflow->>...` predicate follows the same
  // caution `lib/email-ai.ts` documents for JSON-path filters: this read
  // must not depend on getting that operator precedence exactly right, and
  // a handful of a workspace's own Gmail threads is cheap to filter here.
  const { data, error } = await supabase
    .from('unified_conversations')
    .select('id, metadata, connected_accounts!inner(user_id)')
    .eq('connected_accounts.user_id', workspaceId)
    .eq('channel_type', 'gmail')
    .limit(200)

  if (error) throw new Error(`freight attention: could not read unified_conversations — ${error.message}`)

  const out: FreightAttentionConversation[] = []
  for (const row of data ?? []) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const workflow = metadata.freight_workflow as FreightWorkflowRecord | undefined
    if (!workflow || workflow.status === 'SENT') continue
    out.push({ conversationId: row.id as string, workflow })
  }
  return out
}

/**
 * Raise owner attention for every open freight request in a workspace.
 *
 * Idempotent by construction: `observeAttentionItem` keys on
 * (workspace, subject_type, subject_id) and suppresses an unchanged
 * fingerprint, so re-running this every five minutes (this rides the
 * existing construction-ledger cron; see `lib/construction-ledger-cycle.ts`)
 * updates one row per conversation instead of stacking duplicates, and a
 * request whose state has not moved produces no new notification.
 */
export async function projectFreightRequestsToAttention(args: {
  workspaceId: string
  deps?: Partial<FreightAttentionDeps>
}): Promise<FreightAttentionResult> {
  const loadOpenRequests = args.deps?.loadOpenRequests ?? loadOpenFreightRequestsFromDb
  const observe = args.deps?.observe ?? observeAttentionItem

  const requests = await loadOpenRequests(args.workspaceId)
  const result: FreightAttentionResult = {
    considered: requests.length,
    raised: 0,
    skipped: { alreadySent: 0, malformed: 0, unknownStatus: 0 },
  }

  for (const { conversationId, workflow } of requests) {
    if (!workflow || !workflow.status || !workflow.request) {
      result.skipped.malformed++
      continue
    }
    if (workflow.status === 'SENT') {
      result.skipped.alreadySent++
      continue
    }
    const rule = ruleFor(workflow.status)
    if (!rule) {
      result.skipped.unknownStatus++
      continue
    }

    await observe({
      workspaceId: args.workspaceId,
      subjectType: SUBJECT_FREIGHT_REQUEST,
      subjectId: conversationId,
      conversationId,
      title: titleFor(workflow),
      priority: rule.priority,
      nextAction: nextActionFor(workflow),
      fingerprintParts: fingerprintPartsFor(workflow),
      // Nothing progresses here without Wallace: approving, sending, picking
      // between candidates, or supplying a missing document are all his to
      // do. Caye cannot finish any of these herself — sending is a
      // consequential action that requires his explicit approval by design
      // (see CLAUDE.md: "a draft is not a send").
      blockedOnOperator: true,
      resolvableAutonomously: false,
    })
    result.raised++
  }

  return result
}
