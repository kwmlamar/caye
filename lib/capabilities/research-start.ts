import 'server-only'
import { queueResearchRun } from '@/lib/research/runtime'
import type { RegisteredCapability } from './types'

type ResearchStartArgs = { questionId: string }

/**
 * Founder-only durable enqueue. This capability never performs research inline
 * and never grants authority to act on whatever the eventual research finds.
 */
export const researchStartCapability: RegisteredCapability<ResearchStartArgs, Awaited<ReturnType<typeof queueResearchRun>>> = {
  manifest: {
    name: 'research.start', version: 1, namespace: 'research',
    description: 'Durably enqueue one existing Caye research question for a background worker. Does not execute recommendations.',
    access: 'write', risk: 'low',
    inputSchemaId: 'research.start.input.v1', outputSchemaId: 'research.start.output.v1',
  },
  async execute(args, context) {
    if (context.actor.kind !== 'founder') {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'not_authorized',message:'Research can only be started by the founder.',retryable:false} }
    }
    if (context.scope.workspaceId !== null) {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'invalid_scope',message:'Founder research is operator-scoped and cannot run inside a customer workspace.',retryable:false} }
    }
    if (typeof args?.questionId !== 'string' || !args.questionId.trim()) {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'invalid_args',message:'questionId is required.',retryable:false} }
    }
    try {
      const run = await queueResearchRun(args.questionId.trim(), 'founder')
      return {
        status:'staged', data:run,
        evidence:[{kind:'record',id:`research_run:${run.id}`}],
        executionRef:null, auditRef:`research_run:${run.id}`, failure:null,
      }
    } catch (error) {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'unavailable',message:error instanceof Error ? error.message : 'Research run could not be queued.',retryable:true} }
    }
  },
}