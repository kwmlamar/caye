import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { analyzeDecision, compareDecisionOutcome, type DecisionAnalysisInput, type DecisionOutcome, type DecisionRecord } from '@/lib/reasoning/decision-intelligence'
import type { RegisteredCapability } from './types'

type AnalyzeArgs = {
  mode: 'analyze'
  decision: Omit<DecisionAnalysisInput, 'workspaceId'>
}

type CompareArgs = {
  mode: 'compare_outcome'
  record: DecisionRecord
  outcome: DecisionOutcome
}

export type EngineeringDecisionArgs = AnalyzeArgs | CompareArgs

function failed(code: 'invalid_args' | 'invalid_scope' | 'unavailable', message: string, retryable = false) {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code, message, retryable },
  }
}

async function trustedArtifactIds(workspaceId: string, refs: string[]): Promise<Set<string> | null> {
  if (refs.length === 0) return new Set()
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('engineering_artifacts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('id', refs)
  if (error) return null
  return new Set((data ?? []).map((row: { id: string }) => row.id))
}

/**
 * Read-only engineering decision intelligence. It performs no operational action.
 * Evidence refs are verified against canonical workspace-scoped engineering artifacts
 * before analysis, so a reasoning model cannot manufacture evidence by inventing ids.
 */
export const engineeringDecisionAnalysisCapability: RegisteredCapability<EngineeringDecisionArgs, unknown> = {
  manifest: {
    name: 'engineering.decision.analyze',
    version: 1,
    namespace: 'engineering',
    description: 'Compare bounded engineering alternatives using verified workspace evidence, explicit assumptions, uncertainty, reversibility, authority and qualitative predictions. Can also compare a prior prediction with a later observed outcome.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'engineering.decision.analyze.input.v1',
    outputSchemaId: 'engineering.decision.record.v1',
  },

  async execute(args, context) {
    const workspaceId = context.scope.workspaceId
    if (!workspaceId) return failed('invalid_scope', 'Engineering decision analysis requires an active workspace.')
    if (!args || typeof args !== 'object' || !('mode' in args)) return failed('invalid_args', 'A decision analysis mode is required.')

    if (args.mode === 'compare_outcome') {
      if (!args.record || args.record.workspaceId !== workspaceId) {
        return failed('invalid_scope', 'Decision outcome comparison must use a record from the active workspace.')
      }
      try {
        const comparison = compareDecisionOutcome(args.record, args.outcome)
        return {
          status: 'inferred' as const,
          data: comparison,
          evidence: args.outcome.evidenceRefs.map((id) => ({ kind: 'execution' as const, id })),
          executionRef: null,
          auditRef: null,
          failure: null,
        }
      } catch (error) {
        return failed('invalid_args', error instanceof Error ? error.message : 'Outcome comparison input is invalid.')
      }
    }

    if (args.mode !== 'analyze' || !args.decision) return failed('invalid_args', 'Decision analysis input is required.')

    const evidenceRefs = args.decision.evidence.map((item) => item.ref)
    let verified: Set<string> | null
    try {
      verified = await trustedArtifactIds(workspaceId, evidenceRefs)
    } catch {
      return failed('unavailable', 'Engineering evidence could not be verified.', true)
    }
    if (!verified) return failed('unavailable', 'Engineering evidence could not be verified.', true)
    const untrusted = evidenceRefs.filter((ref) => !verified.has(ref))
    if (untrusted.length > 0) {
      return failed('invalid_args', `Decision evidence is not trusted in this workspace: ${untrusted.join(', ')}`)
    }

    try {
      const record = analyzeDecision({ ...args.decision, workspaceId })
      return {
        status: 'inferred' as const,
        data: record,
        evidence: evidenceRefs.map((id) => ({ kind: 'artifact' as const, id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch (error) {
      return failed('invalid_args', error instanceof Error ? error.message : 'Decision analysis input is invalid.')
    }
  },
}
