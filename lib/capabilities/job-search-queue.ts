import 'server-only'

import { getRankedQueue } from '@/lib/job-search/queue'
import type { RegisteredCapability } from './types'

/**
 * Read-only founder ranked job-search queue (CAY-192, Phase 7 — "Show me
 * the best 10"). Never workspace-scoped, same boundary as
 * job-search-summary.ts.
 */
export const jobSearchQueueCapability: RegisteredCapability<Record<string, never>, Awaited<ReturnType<typeof getRankedQueue>>> = {
  manifest: {
    name: 'job_search.queue.list',
    version: 1,
    namespace: 'job_search',
    description: 'Top-ranked QUEUED job-search candidates by fit score.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'job_search.queue.list.input.v1',
    outputSchemaId: 'job_search.queue.list.output.v1',
  },

  async execute() {
    try {
      const queue = await getRankedQueue(10)
      return {
        status: 'observed',
        data: queue,
        evidence: queue.map((item) => ({ kind: 'record' as const, id: item.id })),
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
        failure: { code: 'unavailable', message: 'Job-search queue could not be read.', retryable: true },
      }
    }
  },
}
