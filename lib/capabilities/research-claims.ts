import 'server-only'
import { getAllCurrentClaims } from '@/lib/research/runtime'
import type { RegisteredCapability } from './types'

/** Current/contested research claims only. Superseded/retracted history stays durable but is not presented as current truth. */
export const researchClaimsCapability: RegisteredCapability<Record<string, never>, Awaited<ReturnType<typeof getAllCurrentClaims>>> = {
  manifest: {
    name: 'research.claims', version: 1, namespace: 'research',
    description: 'Read Caye current and contested research claims with explicit evidence links.',
    access: 'read', risk: 'read_only',
    inputSchemaId: 'research.claims.input.v1', outputSchemaId: 'research.claims.output.v1',
  },
  async execute() {
    try {
      const data = await getAllCurrentClaims()
      return { status:'observed', data, evidence:data.map((claim)=>({kind:'record' as const,id:`research_claim:${claim.id}`})), executionRef:null, auditRef:null, failure:null }
    } catch {
      return { status:'failed', data:null, evidence:[], executionRef:null, auditRef:null, failure:{code:'unavailable',message:'Research claims could not be read.',retryable:true} }
    }
  },
}