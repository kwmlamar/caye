import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { ResearchRoutingProvenance } from './types'

/**
 * Persist the routing trail for a run.
 *
 * Caye's *belief* is provider-independent — a claim is a claim regardless of who
 * generated it. The *evidence trail* is deliberately not. If a run silently
 * failed over from OpenAI to Anthropic, that has to be legible later, so the
 * fallback chain is written alongside the serving provider rather than smoothed
 * away into a single vendor string.
 *
 * research_runs.provider (set by persist_research_synthesis) records who served.
 * This adds the routing context and the run's token/cost usage. Merged into the
 * existing provenance jsonb so nothing already recorded is clobbered.
 */
export async function recordResearchRoutingProvenance(
  runId: string,
  routing: ResearchRoutingProvenance,
): Promise<void> {
  const db = createServiceClient()

  const existing = await db
    .from('research_runs')
    .select('provenance,cost_usd')
    .eq('id', runId)
    .maybeSingle()
  if (existing.error) throw existing.error
  if (!existing.data) return

  const base = existing.data.provenance && typeof existing.data.provenance === 'object' && !Array.isArray(existing.data.provenance)
    ? existing.data.provenance as Record<string, unknown>
    : {}

  const update: Record<string, unknown> = {
    provenance: { ...base, routing },
  }
  // Only claim a cost when pricing is actually known for the serving model.
  if (routing.usage.costUsd > 0) {
    update.cost_usd = Number(existing.data.cost_usd ?? 0) + routing.usage.costUsd
  }

  const written = await db.from('research_runs').update(update).eq('id', runId)
  if (written.error) throw written.error
}
