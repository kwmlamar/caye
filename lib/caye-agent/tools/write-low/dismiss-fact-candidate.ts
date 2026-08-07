import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface DismissFactCandidateInput {
  candidate_id: string
}

/**
 * The other half of confirm_fact_candidate's closure loop — for when the
 * operator says no, or the fact was wrong, or it's not worth saving. Without
 * this, a declined proposal has no way to leave 'proposed' status and would
 * either sit forever or (worse) get silently re-proposed on the next
 * occurrence bump, nagging about something already declined.
 */
export const dismissFactCandidate: Tool<DismissFactCandidateInput> = {
  name: 'dismiss_fact_candidate',
  description:
    "Decline a proposed business-fact candidate — the operator said no, or it's wrong, or not " +
    "worth saving as a standing fact. Use when the operator responds to a 'want me to save this?' " +
    "proposal with anything other than agreement. Closes the candidate row so it stops being " +
    "eligible for re-proposal; does not touch business_facts.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: {
        type: 'string',
        description: 'id of the business_fact_candidates row being declined.',
      },
    },
    required: ['candidate_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    const { data: candidate, error: candErr } = await supabase
      .from('business_fact_candidates')
      .select('id, workspace_id, status')
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

    const { error: updateErr } = await supabase
      .from('business_fact_candidates')
      .update({
        status: 'dismissed',
        outcome: 'ignored',
        outcome_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)

    if (updateErr) return { ok: false, error: updateErr.message }
    return { ok: true, data: { candidate_id: candidate.id } }
  },
}
