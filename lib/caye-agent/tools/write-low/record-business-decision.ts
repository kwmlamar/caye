import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveWorkspaceDecisionAuthority } from '@/lib/decision-authority'
import type { Tool } from '../types'

type Input = {
  decision_id: string
  decision: string
}

export const recordBusinessDecision: Tool<Input> = {
  name: 'record_business_decision',
  description: `Record an operator's answer to a pending business decision. Call get_pending_business_decisions first so decision_id is grounded in this operator's current pending list. This validates the operator's authority again at decision time, so stale/revoked delegation fails closed. Recording the decision does not bypass an existing high-risk action gate: if the result includes pending_action_id and the decision approves it, call confirm_pending_action with that id in this same operator turn.`,
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      decision_id: { type: 'string', description: 'Decision id returned by get_pending_business_decisions.' },
      decision: { type: 'string', description: 'The operator decision, faithfully and concisely recorded.' },
    },
    required: ['decision_id', 'decision'],
  },
  async execute(args, ctx) {
    const decision = args.decision?.trim()
    if (!decision) return { ok: false, error: 'A decision is required.' }
    if (ctx.operatorId == null) return { ok: false, error: 'Decision actor identity is unavailable; authority fails closed.' }

    const supabase = createServiceClient()
    const { data: row, error } = await supabase
      .from('caye_owner_attention')
      .select('id,status,decision,decided_at,decision_actor_operator_id,decision_expires_at,required_authority,decision_owner_operator_id,decision_evidence,decision_resume_link')
      .eq('id', args.decision_id)
      .eq('workspace_id', ctx.workspaceId)
      .eq('subject_type', 'decision')
      .maybeSingle()
    if (error) return { ok: false, error: `Could not load that decision: ${error.message}` }
    if (!row) return { ok: false, status: 'NOT_FOUND', error: 'No pending decision with that id exists in this workspace.' }

    if (row.decided_at) {
      const sameActor = Number(row.decision_actor_operator_id) === ctx.operatorId
      const sameDecision = String(row.decision ?? '').trim() === decision
      if (sameActor && sameDecision) {
        return { ok: true, data: { recorded: true, idempotent_replay: true, decision_id: row.id, decision: row.decision } }
      }
      return { ok: false, status: 'CONFLICT', error: 'That decision was already recorded. A duplicate or conflicting response cannot overwrite it.' }
    }

    const expiresAt = row.decision_expires_at as string | null
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return { ok: false, status: 'CONFLICT', error: 'That decision request is stale. Re-read current business state and route a fresh decision.' }
    }
    const requiredAuthority = row.required_authority as string | null
    if (!requiredAuthority) return { ok: false, error: 'Required authority is missing; the decision fails closed.' }

    const authority = await resolveWorkspaceDecisionAuthority({
      workspaceId: ctx.workspaceId,
      actorOperatorId: ctx.operatorId,
      requiredAuthority,
    })
    if (!authority.actorAuthorized || !authority.actor) {
      return { ok: false, status: 'FORBIDDEN', error: 'This operator does not currently hold the authority required for that decision. Nothing was resumed or executed.' }
    }

    const now = new Date().toISOString()
    const { data: claimed, error: claimError } = await supabase
      .from('caye_owner_attention')
      .update({
        status: 'decided',
        decision,
        decided_at: now,
        decision_actor_operator_id: ctx.operatorId,
        decision_actor_authority: requiredAuthority,
        acknowledged_at: now,
        updated_at: now,
      })
      .eq('id', row.id)
      .eq('workspace_id', ctx.workspaceId)
      .is('decided_at', null)
      .select('id')
      .maybeSingle()
    if (claimError) return { ok: false, error: `Could not record the decision: ${claimError.message}` }
    if (!claimed) return { ok: false, status: 'CONFLICT', error: 'That decision was recorded concurrently; nothing was executed twice.' }

    const resume = row.decision_resume_link as { objectiveRunId?: unknown; stepKey?: unknown } | null
    let objectiveResumeReady = false
    if (typeof resume?.objectiveRunId === 'string' && typeof resume?.stepKey === 'string') {
      const { data: objective } = await supabase
        .from('operator_objective_runs')
        .update({
          status: 'waiting',
          blocked_step: resume.stepKey,
          resume_at: now,
          completed_at: null,
          updated_at: now,
          lease_token: null,
          lease_expires_at: null,
        })
        .eq('id', resume.objectiveRunId)
        .eq('workspace_id', ctx.workspaceId)
        .eq('status', 'blocked')
        .select('id')
        .maybeSingle()
      if (objective) {
        objectiveResumeReady = true
        await supabase.from('operator_objective_events').insert({
          run_id: resume.objectiveRunId,
          step_key: resume.stepKey,
          state: 'waiting',
          attempt: 0,
          evidence: { decisionId: row.id, decision, decisionActorOperatorId: ctx.operatorId, requiredAuthority, resumeReady: true },
          occurred_at: now,
        })
      }
    }

    const evidence = row.decision_evidence as { pendingActionId?: unknown } | null
    const pendingActionId = typeof evidence?.pendingActionId === 'string' ? evidence.pendingActionId : null
    return {
      ok: true,
      data: {
        recorded: true,
        decision_id: row.id,
        decision,
        decision_actor_name: authority.actor.name,
        required_authority: requiredAuthority,
        objective_resume_ready: objectiveResumeReady,
        pending_action_id: pendingActionId,
        note: pendingActionId
          ? 'Decision recorded under current authority. If this decision approves the staged action, call confirm_pending_action with pending_action_id now; that existing gate remains the execution boundary.'
          : 'Decision recorded under current authority. Any linked durable objective is now eligible to resume from its blocked step.',
      },
    }
  },
}
