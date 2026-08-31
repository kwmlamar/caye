import 'server-only'

import { randomUUID } from 'node:crypto'
import {
  requiredAuthorityForDomain,
  resolveWorkspaceDecisionAuthority,
  routeBusinessDecision,
} from '@/lib/decision-authority'
import { queueResearchRun } from '@/lib/research/runtime'
import type { ToolContext } from '@/lib/caye-agent/tools/types'
import type { StrategicDependencies } from './service'
import type { StrategicAuthority } from './types'

/**
 * Canonical adapters for strategic intelligence. No second authority resolver,
 * notification queue, research queue, or attention table lives here.
 */
export function createCanonicalStrategicDependencies(input: {
  workspaceId?: string | null
  /** Authenticated founder identity, supplied only by a trusted Direct/server boundary. */
  founderUserId?: string | null
}): StrategicDependencies {
  const workspaceId = input.workspaceId ?? null

  return {
    async resolveAuthority(request): Promise<StrategicAuthority> {
      if (request.scope === 'personal') {
        // Personal strategic authority is only resolvable from an authenticated
        // founder identity. Never infer it from caller role, model context, or a
        // business workspace operator.
        if (!input.founderUserId) {
          return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
        }
        return {
          principalType: 'personal',
          principalRef: `founder:${input.founderUserId}`,
          resolvedBy: 'canonical_authority',
        }
      }

      const targetWorkspace = request.workspaceRef ?? workspaceId
      if (!targetWorkspace) {
        return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
      }
      const resolution = await resolveWorkspaceDecisionAuthority({
        workspaceId: targetWorkspace,
        actorOperatorId: null,
        requiredAuthority: requiredAuthorityForDomain('business_policy'),
      })
      const principal = resolution.preferredDecisionOwner
      if (!principal) {
        return { principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved' }
      }
      return {
        principalType: 'business',
        principalRef: `operator:${principal.id}`,
        resolvedBy: 'canonical_authority',
      }
    },

    async enqueueCanonicalAttention(attention) {
      if (!workspaceId || attention.authority.principalType !== 'business') {
        // There is no separate founder/personal proactive-notification framework
        // to fall back to. Do not claim an interruption happened when it did not.
        return false
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
        evidence: {
          source: 'strategic_intelligence',
          escalationLevel: 5,
          materialFingerprint: attention.dedupeKey,
        },
        resumeLink: { kind: 'strategic_intelligence', fingerprint: attention.dedupeKey },
      })
      // An attention row without successful delivery is durable pending work,
      // not proof that the human was interrupted.
      return routed.routed
    },

    async requestDeeperResearch(signal) {
      if (!signal.researchQuestionId) return
      await queueResearchRun(signal.researchQuestionId, 'strategic-level-2')
    },

    async requestIndependentCrossCheck(signal) {
      if (!signal.researchQuestionId) return
      // Research Runtime dedupes an already-active question. The run is tagged
      // separately so synthesis can demand corroboration rather than treating
      // the second pass as an independent source by fiat.
      await queueResearchRun(signal.researchQuestionId, 'strategic-cross-check')
    },
  }
}
