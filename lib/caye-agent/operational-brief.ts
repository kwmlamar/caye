import 'server-only'

import { getOperationalBrief } from '@/lib/operational-intelligence/runtime'
import { renderOperationalBrief, type OperationalBrief } from '@/lib/operational-intelligence/brief'

/**
 * Small agent-facing context function for questions like
 * "What is going on with ODS right now?"
 *
 * The model does not assemble operational truth. This function does. It reads
 * authoritative Bedrock state plus Caye's own event/attention state, then hands
 * the model a deterministic brief where facts, inferences, unknowns, freshness,
 * and provenance are already explicit.
 */
export async function getOperationalBriefContext(workspaceId: string): Promise<{
  brief: OperationalBrief
  rendered: string
}> {
  const brief = await getOperationalBrief(workspaceId)
  return {
    brief,
    rendered: [
      'CURRENT OPERATIONAL BRIEF',
      'Use FACT as stated source truth. Treat INFERENCE as interpretation, never as confirmed source state. Preserve UNKNOWN rather than converting it to none.',
      '',
      renderOperationalBrief(brief),
    ].join('\n'),
  }
}
