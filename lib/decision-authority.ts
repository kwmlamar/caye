import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { observeAttentionItem, markAttentionNotified } from '@/lib/owner-attention'
import { sendOperatorMessage } from '@/lib/caye-agent/tools/write-low/send-operator-message'
import type { Role, ToolContext, ToolResult } from '@/lib/caye-agent/tools/types'

export type DecisionRisk = 'routine' | 'consequential' | 'high'
export type DecisionDomain =
  | 'booking_capacity'
  | 'booking_management'
  | 'payment_policy'
  | 'customer_communication'
  | 'outreach_control'
  | 'service_policy'
  | 'team_management'
  | 'business_policy'
  | 'routing_admin'

export type DecisionPrincipal = {
  id: number
  name: string | null
  role: Role
  verifiedAt: string | null
  directScopes: string[]
  delegatedScopes: string[]
  preferredDelegation: boolean
}

export type DecisionAuthorityResolution = {
  requiredAuthority: string
  actorAuthorized: boolean
  actor: DecisionPrincipal | null
  authorizedPrincipals: DecisionPrincipal[]
  preferredDecisionOwner: DecisionPrincipal | null
  evidence: Record<string, unknown>
}

const DOMAIN_AUTHORITY: Record<DecisionDomain, string> = {
  booking_capacity: 'business.booking.capacity',
  booking_management: 'business.booking.manage',
  payment_policy: 'business.payment.policy',
  customer_communication: 'business.customer.communication',
  outreach_control: 'business.outreach.control',
  service_policy: 'business.service.policy',
  team_management: 'business.team.manage',
  business_policy: 'business.policy',
  routing_admin: 'routing.admin',
}

const HIGH_RISK_DOMAIN: Record<string, DecisionDomain> = {
  send_reply: 'customer_communication',
  send_payment_link: 'payment_policy',
  confirm_booking: 'booking_management',
  reschedule_booking: 'booking_management',
  cancel_booking: 'booking_management',
  create_customer_booking: 'booking_capacity',
  remove_service: 'service_policy',
  remove_pricing_tier: 'service_policy',
  remove_blackout_date: 'service_policy',
  remove_team_member: 'team_management',
  send_outreach_batch: 'outreach_control',
  expand_outreach_target: 'outreach_control',
  draft_in_inbox: 'customer_communication',
}

export function requiredAuthorityForDomain(domain: DecisionDomain): string {
  return DOMAIN_AUTHORITY[domain]
}

export function classifyHighRiskDecision(toolName: string): DecisionDomain | null {
  return HIGH_RISK_DOMAIN[toolName] ?? null
}

export function authorityScopeMatches(grant: string, required: string): boolean {
  const normalizedGrant = grant.trim()
  if (!normalizedGrant) return false
  if (normalizedGrant === required) return true
  if (!normalizedGrant.endsWith('.*')) return false
  const prefix = normalizedGrant.slice(0, -2)
  return required === prefix || required.startsWith(`${prefix}.`)
}

function principalHasAuthority(principal: DecisionPrincipal, required: string): boolean {
  return [...principal.directScopes, ...principal.delegatedScopes].some((scope) =>
    authorityScopeMatches(scope, required)
  )
}

function principalOrder(a: DecisionPrincipal, b: DecisionPrincipal): number {
  if (a.preferredDelegation !== b.preferredDelegation) return a.preferredDelegation ? -1 : 1
  const roleRank: Record<Role, number> = { owner: 0, staff: 1, founder: 2, driver: 3 }
  const roleDelta = roleRank[a.role] - roleRank[b.role]
  if (roleDelta !== 0) return roleDelta
  return a.id - b.id
}

export function resolveDecisionAuthorityFromPrincipals(input: {
  principals: DecisionPrincipal[]
  actorOperatorId: number | null | undefined
  requiredAuthority: string
}): DecisionAuthorityResolution {
  const verified = input.principals.filter((principal) => !!principal.verifiedAt)
  const authorizedPrincipals = verified
    .filter((principal) => principalHasAuthority(principal, input.requiredAuthority))
    .sort(principalOrder)
  const actor = input.actorOperatorId == null
    ? null
    : verified.find((principal) => principal.id === input.actorOperatorId) ?? null
  const actorAuthorized = !!actor && principalHasAuthority(actor, input.requiredAuthority)

  return {
    requiredAuthority: input.requiredAuthority,
    actorAuthorized,
    actor,
    authorizedPrincipals,
    preferredDecisionOwner: actorAuthorized ? actor : authorizedPrincipals[0] ?? null,
    evidence: {
      actorOperatorId: input.actorOperatorId ?? null,
      verifiedPrincipalIds: verified.map((principal) => principal.id),
      authorizedPrincipalIds: authorizedPrincipals.map((principal) => principal.id),
      preferredDecisionOwnerId: (actorAuthorized ? actor : authorizedPrincipals[0])?.id ?? null,
    },
  }
}

export async function resolveWorkspaceDecisionAuthority(input: {
  workspaceId: string
  actorOperatorId?: number | null
  requiredAuthority: string
}): Promise<DecisionAuthorityResolution> {
  const supabase = createServiceClient()
  const { data: operators, error: operatorError } = await supabase
    .from('operator_allowlist')
    .select('id,name,role,verified_at,decision_scopes')
    .eq('workspace_id', input.workspaceId)

  if (operatorError) {
    return {
      requiredAuthority: input.requiredAuthority,
      actorAuthorized: false,
      actor: null,
      authorizedPrincipals: [],
      preferredDecisionOwner: null,
      evidence: { failClosed: true, reason: 'operator_authority_lookup_failed', error: operatorError.message },
    }
  }

  const now = new Date().toISOString()
  const { data: delegations, error: delegationError } = await supabase
    .from('operator_authority_delegations')
    .select('delegate_operator_id,scopes,preferred,granted_by_operator_id,valid_from,expires_at,revoked_at')
    .eq('workspace_id', input.workspaceId)
    .is('revoked_at', null)
    .lte('valid_from', now)

  if (delegationError) {
    return {
      requiredAuthority: input.requiredAuthority,
      actorAuthorized: false,
      actor: null,
      authorizedPrincipals: [],
      preferredDecisionOwner: null,
      evidence: { failClosed: true, reason: 'delegation_lookup_failed', error: delegationError.message },
    }
  }

  const activeDelegations = (delegations ?? []).filter((row) => {
    const expiresAt = row.expires_at as string | null
    return !expiresAt || Date.parse(expiresAt) > Date.now()
  })
  const principals: DecisionPrincipal[] = (operators ?? []).map((row) => {
    const grants = activeDelegations.filter((grant) => Number(grant.delegate_operator_id) === Number(row.id))
    return {
      id: Number(row.id),
      name: (row.name as string | null) ?? null,
      role: row.role as Role,
      verifiedAt: (row.verified_at as string | null) ?? null,
      directScopes: Array.isArray(row.decision_scopes) ? (row.decision_scopes as string[]) : [],
      delegatedScopes: grants.flatMap((grant) => Array.isArray(grant.scopes) ? (grant.scopes as string[]) : []),
      preferredDelegation: grants.some((grant) => grant.preferred === true),
    }
  })

  const resolved = resolveDecisionAuthorityFromPrincipals({
    principals,
    actorOperatorId: input.actorOperatorId,
    requiredAuthority: input.requiredAuthority,
  })
  return {
    ...resolved,
    evidence: {
      ...resolved.evidence,
      source: 'operator_allowlist+operator_authority_delegations',
      activeDelegationCount: activeDelegations.length,
    },
  }
}

export function decisionSubjectKey(parts: unknown[]): string {
  return createHash('sha256')
    .update(parts.map((part) => JSON.stringify(part ?? null)).join('\u0000'))
    .digest('hex')
    .slice(0, 32)
}

async function persistDecisionAttention(input: {
  workspaceId: string
  subjectKey: string
  summary: string
  domain: DecisionDomain
  risk: DecisionRisk
  requiredAuthority: string
  decisionOwnerOperatorId: number | null
  requestedByOperatorId: number | null
  expiresAt: string
  evidence?: Record<string, unknown>
  resumeLink?: Record<string, unknown> | null
}) {
  const attention = await observeAttentionItem({
    workspaceId: input.workspaceId,
    subjectType: 'decision',
    subjectId: input.subjectKey,
    title: input.summary,
    priority: 'decision',
    nextAction: 'Await the authorized decision owner, then resume the blocked work.',
    fingerprintParts: [input.domain, input.requiredAuthority, input.summary, input.decisionOwnerOperatorId],
    blockedOnOperator: true,
    resolvableAutonomously: false,
  })
  if (!attention) return null

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('caye_owner_attention')
    .update({
      decision_domain: input.domain,
      required_authority: input.requiredAuthority,
      decision_risk: input.risk,
      decision_owner_operator_id: input.decisionOwnerOperatorId,
      decision_requested_by_operator_id: input.requestedByOperatorId,
      decision_requested_at: new Date().toISOString(),
      decision_expires_at: input.expiresAt,
      decision_evidence: input.evidence ?? {},
      decision_resume_link: input.resumeLink ?? null,
    })
    .eq('id', attention.id)
    .eq('workspace_id', input.workspaceId)
  if (error) return null
  return attention
}

async function appendRoutingAttempt(input: {
  workspaceId: string
  attentionId: string
  attempt: Record<string, unknown>
}) {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('caye_owner_attention')
    .select('routing_attempts')
    .eq('id', input.attentionId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle()
  const existing = Array.isArray(data?.routing_attempts) ? data.routing_attempts : []
  await supabase
    .from('caye_owner_attention')
    .update({ routing_attempts: [...existing, input.attempt] })
    .eq('id', input.attentionId)
    .eq('workspace_id', input.workspaceId)
}

export async function routeBusinessDecision(input: {
  ctx: ToolContext
  domain: DecisionDomain
  risk: DecisionRisk
  subjectKey: string
  summary: string
  expiresInMinutes?: number
  evidence?: Record<string, unknown>
  resumeLink?: Record<string, unknown> | null
  resolution?: DecisionAuthorityResolution
}): Promise<{
  resolution: DecisionAuthorityResolution
  attentionId: string | null
  routed: boolean
  deliveredTo: DecisionPrincipal | null
  result: ToolResult
}> {
  const requiredAuthority = requiredAuthorityForDomain(input.domain)
  const resolution = input.resolution ?? await resolveWorkspaceDecisionAuthority({
    workspaceId: input.ctx.workspaceId,
    actorOperatorId: input.ctx.operatorId,
    requiredAuthority,
  })

  if (resolution.actorAuthorized && resolution.actor) {
    return {
      resolution,
      attentionId: null,
      routed: false,
      deliveredTo: resolution.actor,
      result: {
        ok: true,
        data: {
          decision_required: true,
          current_actor_authorized: true,
          decision_owner_name: resolution.actor.name,
          required_authority: requiredAuthority,
          note: 'This decision belongs to the current operator, so ask them one concise decision question.',
        },
      },
    }
  }

  const owner = resolution.preferredDecisionOwner
  const expiresAt = new Date(Date.now() + Math.max(15, input.expiresInMinutes ?? 24 * 60) * 60_000).toISOString()
  const attention = await persistDecisionAttention({
    workspaceId: input.ctx.workspaceId,
    subjectKey: input.subjectKey,
    summary: input.summary,
    domain: input.domain,
    risk: input.risk,
    requiredAuthority,
    decisionOwnerOperatorId: owner?.id ?? null,
    requestedByOperatorId: input.ctx.operatorId ?? null,
    expiresAt,
    evidence: { ...(input.evidence ?? {}), authorityResolution: resolution.evidence },
    resumeLink: input.resumeLink,
  })

  if (!owner) {
    return {
      resolution,
      attentionId: attention?.id ?? null,
      routed: false,
      deliveredTo: null,
      result: {
        ok: false,
        status: 'NEEDS_HUMAN',
        error_code: 'DECISION_AUTHORITY_UNRESOLVED',
        error: 'This business decision has no verified authorized decision owner configured. I kept it pending instead of asking the current caller to approve it.',
        data: { decision_required: true, current_actor_authorized: false, persisted: !!attention },
      },
    }
  }

  if (!attention) {
    return {
      resolution,
      attentionId: null,
      routed: false,
      deliveredTo: null,
      result: {
        ok: false,
        status: 'RETRYABLE',
        error_code: 'DECISION_PERSIST_FAILED',
        error: `The decision belongs to ${owner.name ?? 'an authorized operator'}, but I could not persist the pending decision safely, so I did not treat anyone else as the approver.`,
      },
    }
  }

  const orderedTargets = [owner, ...resolution.authorizedPrincipals.filter((principal) => principal.id !== owner.id)]
  for (const target of orderedTargets) {
    const message = `I need your decision on this before I continue: ${input.summary}\n\nReply with your decision and I’ll resume the blocked work.`
    const delivery = await sendOperatorMessage.execute(
      { operator_allowlist_id: target.id, message },
      {
        ...input.ctx,
        operationKey: `decision-route:${attention.id}:${target.id}`,
      }
    )
    await appendRoutingAttempt({
      workspaceId: input.ctx.workspaceId,
      attentionId: attention.id,
      attempt: {
        at: new Date().toISOString(),
        operatorId: target.id,
        operatorName: target.name,
        channel: 'whatsapp',
        ok: delivery.ok,
        status: delivery.status ?? null,
        errorCode: delivery.error_code ?? null,
        error: delivery.error ?? null,
      },
    })
    if (delivery.ok && (delivery.data as { sent?: unknown } | undefined)?.sent === true) {
      await markAttentionNotified(input.workspaceId, attention.id, message).catch(() => undefined)
      return {
        resolution,
        attentionId: attention.id,
        routed: true,
        deliveredTo: target,
        result: {
          ok: true,
          data: {
            decision_required: true,
            current_actor_authorized: false,
            decision_owner_name: owner.name,
            routed_to_name: target.name,
            routed: true,
            pending_decision_id: attention.id,
            note: `This decision belongs to ${owner.name ?? 'the authorized decision owner'}. I routed it to ${target.name ?? 'an authorized operator'} and will keep the work pending until an authorized decision arrives. Do not ask the current caller to approve it.`,
          },
        },
      }
    }
  }

  return {
    resolution,
    attentionId: attention.id,
    routed: false,
    deliveredTo: null,
    result: {
      ok: true,
      data: {
        decision_required: true,
        current_actor_authorized: false,
        decision_owner_name: owner.name,
        routed: false,
        persisted: true,
        pending_decision_id: attention.id,
        note: `This decision belongs to ${owner.name ?? 'the authorized decision owner'}. Delivery failed on the configured safe routes, so I kept it pending. Do not ask the current caller to approve it or choose a channel unless they separately hold routing-admin authority.`,
      },
    },
  }
}
