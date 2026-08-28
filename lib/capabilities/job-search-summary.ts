import 'server-only'

import { getDailySummary } from '@/lib/job-search/summary'
import type { RegisteredCapability } from './types'

/**
 * Read-only founder daily job-search summary (CAY-192, Phase 7). Never
 * workspace-scoped — ignores context.scope.workspaceId entirely rather
 * than branching on it, so this cannot be tricked into mixing founder
 * job-search data with a customer workspace context (see the founder-
 * data-leakage regression test in lib/job-search/leakage.test.ts).
 */
export const jobSearchSummaryCapability: RegisteredCapability<Record<string, never>, Awaited<ReturnType<typeof getDailySummary>>> = {
  manifest: {
    name: 'job_search.summary',
    version: 1,
    namespace: 'job_search',
    description: "Founder's daily job-search pipeline summary (sourced/qualified/needs-human/submitted/rejected counts).",
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'job_search.summary.input.v1',
    outputSchemaId: 'job_search.summary.output.v1',
  },

  async execute() {
    try {
      const summary = await getDailySummary()
      return {
        status: 'observed',
        data: summary,
        evidence: [{ kind: 'record', id: `job_search_summary:${summary.businessDate}` }],
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
        failure: { code: 'unavailable', message: 'Job-search summary could not be read.', retryable: true },
      }
    }
  },
}
