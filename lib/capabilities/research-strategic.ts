import 'server-only'

import { buildStrategicResearchSnapshot } from '@/lib/strategic-intelligence/snapshot'
import type { RegisteredCapability } from './types'

/**
 * Human-facing strategic projection over the canonical Research Runtime.
 * It exposes material synthesis, not raw research rows or implementation ids.
 */
export const researchStrategicCapability: RegisteredCapability<
  Record<string, never>,
  Awaited<ReturnType<typeof buildStrategicResearchSnapshot>>
> = {
  manifest: {
    name: 'research.strategic',
    version: 1,
    namespace: 'research',
    description: 'Read Caye strategic intelligence: material weekly changes, strongest beliefs, opportunities, threats, missing angles, recommendations, and active investigations.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'research.strategic.input.v1',
    outputSchemaId: 'research.strategic.output.v1',
  },
  async execute() {
    try {
      const data = await buildStrategicResearchSnapshot()
      return {
        status: 'inferred',
        data,
        evidence: [{ kind: 'analysis' as const, id: 'research:strategic-current' }],
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return {
        status: 'failed',
        data: null,
        evidence: [],
        executionRef: null,
        auditRef: null,
        failure: {
          code: 'unavailable',
          message: 'Strategic intelligence could not be assembled from current research evidence.',
          retryable: true,
        },
      }
    }
  },
}
