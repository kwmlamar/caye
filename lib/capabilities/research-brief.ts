import 'server-only'
import { getLatestBriefs } from '@/lib/research/runtime'
import type { RegisteredCapability } from './types'

/** Latest revision per researched question. Historical revisions remain durable in research_briefs. */
export const researchBriefCapability: RegisteredCapability<Record<string, never>, Awaited<ReturnType<typeof getLatestBriefs>>> = {
  manifest: {
    name: 'research.brief', version: 1, namespace: 'research',
    description: 'Read the latest revisioned research brief for each Caye research question.',
    access: 'read', risk: 'read_only',
    inputSchemaId: 'research.brief.input.v1', outputSchemaId: 'research.brief.output.v1',
  },
  async execute() {
    try {
      const data = await getLatestBriefs()
      return { status:'observed', data, evidence:data.map((brief)=>({kind:'record' as const,id:`research_brief:${brief.id}`})), executionRef:null, auditRef:null, failure:null }
    } catch {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'unavailable',message:'Research briefs could not be read.',retryable:true} }
    }
  },
}