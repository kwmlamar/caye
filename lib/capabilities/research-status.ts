import 'server-only'
import { getResearchStatus } from '@/lib/research/runtime'
import type { RegisteredCapability } from './types'

/** Founder/operator research state. Never workspace-scoped. */
export const researchStatusCapability: RegisteredCapability<Record<string, never>, Awaited<ReturnType<typeof getResearchStatus>>> = {
  manifest: {
    name: 'research.status', version: 1, namespace: 'research',
    description: 'Read Caye research programs, questions, and durable run status.',
    access: 'read', risk: 'read_only',
    inputSchemaId: 'research.status.input.v1', outputSchemaId: 'research.status.output.v1',
  },
  async execute() {
    try {
      const data = await getResearchStatus()
      return { status:'observed', data, evidence:data.map((program)=>({kind:'record' as const,id:`research_program:${program.id}`})), executionRef:null, auditRef:null, failure:null }
    } catch {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'unavailable',message:'Research status could not be read.',retryable:true} }
    }
  },
}