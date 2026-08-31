import 'server-only'

import { randomUUID } from 'node:crypto'
import {
  requiredAuthorityForDomain,
  resolveWorkspaceDecisionAuthority,
  routeBusinessDecision,
} from '@/lib/decision-authority'
import { queueResearchRun } from '@/lib/research/runtime'
import { createServiceClient } from '@/lib/supabase-server'
import type { ToolContext } from '@/lib/caye-agent/tools/types'
import type { StrategicDependencies } from './service'
import type { StrategicAuthority } from './types'

async function enqueueFounderWhatsAppAlert(input: {
  workspaceId: string
  founderUserId: string
  title: string
  body: string
  dedupeKey: string
}): Promise<boolean> {
  const db = createServiceClient()
  const preference = await db
    .from('founder_notification_preferences')
    .select('whatsapp_enabled,min_escalation_level')
    .eq('founder_user_id', input.founderUserId)
    .maybeSingle()
  if (preference.error || !preference.data?.whatsapp_enabled || Number(preference.data.min_escalation_level ?? 5) > 5) return false

  const membership = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.founderUserId)
    .maybeSingle()
  if (membership.error || !membership.data) return false

  const operators = await db
    .from('operator_allowlist')
    .select('id,phone')
    .eq('workspace_id', input.workspaceId)
    .eq('role', 'founder')
    .not('verified_at', 'is', null)
    .limit(2)
  if (operators.error || operators.data?.length !== 1 || !operators.data[0]?.phone) return false

  const message = [`Caye found something important.`, '', input.title, input.body].filter(Boolean).join('\n').slice(0, 1800)
  const queued = await db.from('caye_outbound_queue').insert({
    workspace_id: input.workspaceId,
    kind: 'operator_reminder',
    payload: {
      to_phone: operators.data[0].phone,
      body: message,
      original_request: 'strategic_intelligence_level_5',
    },
    idempotency_key: `strategic-whatsapp:${input.founderUserId}:${input.dedupeKey}`,
  })
  if (!queued.error) return true
  return queued.error.code === '23505'
}

/** Canonical adapters for strategic intelligence. */
export function createCanonicalStrategicDependencies(input: {
  workspaceId?: string | null
  /** Authenticated founder identity, supplied only by a trusted Direct/server boundary. */
  founderUserId?: string | null
}): StrategicDependencies {
  const workspaceId = input.workspaceId ?? null

  return {
    async resolveAuthority(request): Promise<StrategicAuthority> {
      if (request.scope === 'personal') {
        if (!input.founderUserId) return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
        return { principalType: 'personal', principalRef: `founder:${input.founderUserId}`, resolvedBy: 'canonical_authority' }
      }

      const targetWorkspace = request.workspaceRef ?? workspaceId
      if (!targetWorkspace) return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
      const resolution = await resolveWorkspaceDecisionAuthority({
        workspaceId: targetWorkspace,
        actorOperatorId: null,
        requiredAuthority: requiredAuthorityForDomain('business_policy'),
      })
      const principal = resolution.preferredDecisionOwner
      if (!principal) return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
      return { principalType: 'business', principalRef: `operator:${principal.id}`, resolvedBy: 'canonical_authority' }
    },

    async enqueueCanonicalAttention(attention) {
      if (attention.authority.principalType === 'personal') {
        if (!workspaceId || !input.founderUserId || attention.authority.principalRef !== `founder:${input.founderUserId}`) return false
        return enqueueFounderWhatsAppAlert({
          workspaceId,
          founderUserId: input.founderUserId,
          title: attention.title,
          body: attention.body,
          dedupeKey: attention.dedupeKey,
        })
      }

      if (!workspaceId || attention.authority.principalType !== 'business') return false

      const { data: existing } = await createServiceClient()
        .from('caye_owner_attention')
        .select('status,state_fingerprint,notified_fingerprint,pending_notification_queue_id')
        .eq('workspace_id', workspaceId)
        .eq('subject_type', 'decision')
        .eq('subject_id', attention.dedupeKey)
        .maybeSingle()

      if (existing) {
        if (existing.status === 'resolved' || existing.status === 'dismissed') return false
        if (existing.pending_notification_queue_id) return false
        if (existing.state_fingerprint && existing.state_fingerprint === existing.notified_fingerprint) return false
      }

      const ctx: ToolContext = {
        workspaceId,
        callerRole: 'founder',
        operatorId: null,
        requestId: `strategic-intelligence:${randomUUID()}`,
        origin: 'scan',
      }
      const routed = await routeBusinessDecision({
        ctx,
        domain: 'business_policy',
        risk: 'consequential',
        subjectKey: attention.dedupeKey,
        summary: `${attention.title}: ${attention.body}`,
        evidence: { source: 'strategic_intelligence', escalationLevel: 5, materialFingerprint: attention.dedupeKey },
        resumeLink: { kind: 'strategic_intelligence', fingerprint: attention.dedupeKey },
      })
      return routed.routed
    },

    async requestDeeperResearch(signal) {
      if (!signal.researchQuestionId) return
      await queueResearchRun(signal.researchQuestionId, 'strategic-level-2')
    },

    async requestIndependentCrossCheck(signal) {
      if (!signal.researchQuestionId) return
      await queueResearchRun(signal.researchQuestionId, 'strategic-cross-check')
    },
  }
}
