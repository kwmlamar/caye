import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { normalizeSentence } from '@/lib/business-fact-candidate-detection'
import { loadScheduleConfig, localDateISO, endOfLocalDayUTC } from '@/lib/whatsapp/schedule'
import { findConflictingFact, outranksForSupersession } from '@/lib/business-fact-conflict'
import type { Tool } from '../types'

interface ConfirmFactCandidateInput {
  candidate_id: string
  fact: string
  category?: 'policy' | 'service_detail' | 'special_handling' | 'logistics'
  expires_on?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Closes the loop add_business_fact never closed. Before this tool existed, an
 * owner replying "yes" to a proposed candidate (business-fact-suggestions.ts)
 * just made Caye call add_business_fact directly — which writes a fresh
 * business_facts row with no link back to the candidate it came from. The
 * candidate row stayed status='proposed' forever. Confirmed live: every one of
 * the 8 candidates that has ever existed is still 'pending' or 'proposed', none
 * ever closed, so there has never been any way to measure how often a proposed
 * fact needed correcting — the exact signal briefs/cold-start-plan.md's decision
 * 7 (the manual gate on backfilling Bimini) depends on.
 *
 * Use THIS instead of add_business_fact whenever the fact being saved traces
 * back to a proposal Caye made — i.e. whenever the sliding-window context shows
 * a "want me to save this as a standing fact?" message and the operator agreed.
 * add_business_fact stays the right tool for a fact the operator volunteers
 * unprompted, with no proposal in context.
 */
export const confirmFactCandidate: Tool<ConfirmFactCandidateInput> = {
  name: 'confirm_fact_candidate',
  description:
    "Save a proposed business-fact candidate as a real, standing fact, and close out the " +
    "candidate row it came from. Use this — NOT add_business_fact — when the operator agrees " +
    "to a fact Caye already proposed (a 'want me to save this as a standing fact?' message in " +
    "the recent conversation). Pass candidate_id from that proposal.\n\n" +
    "Pass `fact` as the final text to save — if the operator just said 'yes', reuse the " +
    "proposed wording verbatim; if they corrected or refined it, pass their version instead. " +
    "This tool tells the difference itself (confirmed vs corrected) from what you pass, so " +
    "don't paraphrase — pass exactly what should be saved.\n\n" +
    "category defaults to the guess the candidate was filed under; override it if the operator's " +
    "correction changes what kind of fact this is. expires_on works exactly as in add_business_fact.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: {
        type: 'string',
        description: 'id of the business_fact_candidates row this proposal came from.',
      },
      fact: {
        type: 'string',
        description: 'The final fact text to save, as a complete standalone sentence.',
      },
      category: {
        type: 'string',
        enum: ['policy', 'service_detail', 'special_handling', 'logistics'],
        description: "Override the candidate's category guess if the correction changed it.",
      },
      expires_on: {
        type: 'string',
        description: "Optional 'YYYY-MM-DD'. Same semantics as add_business_fact.",
      },
    },
    required: ['candidate_id', 'fact'],
  },

  async execute(args, ctx) {
    const fact = args.fact.trim()
    if (fact.length < 5) return { ok: false, error: 'Fact is too short to be useful.' }
    if (fact.length > 800) return { ok: false, error: 'Fact is too long — keep it to one sentence.' }

    const supabase = createServiceClient()

    const { data: candidate, error: candErr } = await supabase
      .from('business_fact_candidates')
      .select('id, workspace_id, sample_text, category_guess, status')
      .eq('id', args.candidate_id)
      .maybeSingle()

    if (candErr) return { ok: false, error: candErr.message }
    if (!candidate) return { ok: false, error: 'No candidate found with that id.' }
    if (candidate.workspace_id !== ctx.workspaceId) {
      return { ok: false, error: 'That candidate belongs to a different workspace.' }
    }
    if (candidate.status === 'resolved' || candidate.status === 'dismissed') {
      return { ok: false, error: `This candidate was already ${candidate.status}.` }
    }

    let expiresAt: string | undefined
    if (args.expires_on) {
      if (!ISO_DATE.test(args.expires_on)) {
        return { ok: false, error: "expires_on must be 'YYYY-MM-DD'." }
      }
      const { timezone } = await loadScheduleConfig(ctx.workspaceId)
      const todayISO = localDateISO(new Date(), timezone)
      if (args.expires_on < todayISO) {
        return {
          ok: false,
          error: `${args.expires_on} is in the past (today is ${todayISO}) — check the year before retrying.`,
        }
      }
      expiresAt = endOfLocalDayUTC(args.expires_on, timezone).toISOString()
    }

    const category = args.category ?? candidate.category_guess

    // CAY-14: this fact is Caye's own inference (a repeated pattern the
    // owner approved), not an owner-direct statement — rule 3 says
    // owner-direct corrections outrank inferred/model-generated knowledge,
    // so it must never silently supersede an explicit owner-direct fact.
    // Check against active facts the same way add_business_fact does.
    const { data: existingRows, error: existingErr } = await supabase
      .from('business_facts')
      .select('id, fact, source, expires_at')
      .eq('workspace_id', ctx.workspaceId)
      .is('superseded_at', null)

    if (existingErr) return { ok: false, error: existingErr.message }

    const now = Date.now()
    const active = (existingRows ?? []).filter(
      (r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now
    )

    const conflict = await findConflictingFact(
      fact,
      active.map((r) => ({ id: r.id, text: r.fact, source: r.source })),
      { workspaceId: ctx.workspaceId, source: 'confirm-fact-candidate.ts:execute' }
    )
    const conflictingRow = conflict.conflictId ? active.find((r) => r.id === conflict.conflictId) : undefined

    if (conflictingRow) {
      const allowedToSupersede =
        conflict.resolution === 'supersede' && outranksForSupersession('candidate-confirmed', conflictingRow.source)
      if (!allowedToSupersede) {
        return {
          ok: false,
          error:
            `This may conflict with an existing fact instead of just adding to it: "${conflictingRow.fact}". ` +
            `Ask the owner directly whether this replaces that fact before saving — an inferred pattern ` +
            `cannot silently override an owner-taught fact.`,
        }
      }
    }

    const { data: newFact, error: insertErr } = await supabase
      .from('business_facts')
      .insert({
        workspace_id: ctx.workspaceId,
        category,
        fact,
        source: 'candidate-confirmed',
        created_by: ctx.callerRole,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      })
      .select('id, created_at')
      .single()

    if (insertErr) return { ok: false, error: insertErr.message }

    if (conflictingRow && conflict.resolution === 'supersede') {
      const { error: supersedeErr } = await supabase
        .from('business_facts')
        .update({ superseded_by: newFact.id, superseded_at: new Date().toISOString() })
        .eq('id', conflictingRow.id)
      if (supersedeErr) {
        console.warn('[confirm_fact_candidate] fact saved but supersession failed:', supersedeErr.message)
      }
    }

    // Whitespace-insensitive comparison, same as classifyOutboundAuthorship
    // (lib/message-authorship.ts) — reflowing a sentence isn't a correction.
    const outcome =
      normalizeSentence(fact) === normalizeSentence(candidate.sample_text) ? 'confirmed' : 'corrected'

    const { error: closeErr } = await supabase
      .from('business_fact_candidates')
      .update({
        status: 'resolved',
        outcome,
        outcome_at: new Date().toISOString(),
        resolved_fact_id: newFact.id,
      })
      .eq('id', candidate.id)

    if (closeErr) {
      // The fact is already saved — that's the part that matters to the guest-
      // facing side. A failure closing the candidate row only affects
      // bookkeeping, so surface it but don't roll back the insert.
      console.warn('[confirm_fact_candidate] fact saved but candidate close-out failed:', closeErr.message)
    }

    return {
      ok: true,
      data: { fact_id: newFact.id, created_at: newFact.created_at, outcome },
    }
  },
}
