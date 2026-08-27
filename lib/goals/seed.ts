import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createGoal } from './goals'
import type { ActivationCondition, GoalCreatedByKind } from './types'

/**
 * Starter operator-scope direction — the generic shape from the product
 * spec (Vision -> Business/Personal/Research domains -> their objectives).
 * This is illustrative PRODUCT strategy content (what Caye-the-product is
 * for), not any individual founder's personal life plan, and it is never
 * run automatically: a founder must explicitly trigger it (POST
 * /api/founder/goals/seed). It is idempotent — safe to call more than once
 * — and entirely operator-scope (workspace_id null); it never touches a
 * customer workspace, matching "dashboard does not require seeded goals to
 * function" and the empty-state requirement.
 *
 * Parameterized by createdByUserId so the record's provenance is real
 * (whoever actually clicked the button), not a hardcoded identity.
 */

const ROBOTICS_ACTIVATION: ActivationCondition[] = [
  { metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000, sustained_days: 180,
    note: 'Caye MRR sustained at or above $20k for 6 months' },
  { metric_key: 'operator_intervention_rate', comparator: '<=', threshold: 0.10, sustained_days: 180,
    note: 'Operator intervention rate at or below 10% for 6 months' },
  { metric_key: 'operator_approval', comparator: '==', threshold: 1,
    note: 'Requires an explicit founder approval metric row — never satisfied by other metrics alone' },
]

interface SeedResult {
  created: boolean
  visionId?: string
  reason?: string
}

export async function seedStarterDirection(createdByUserId: string): Promise<SeedResult> {
  const supabase = createServiceClient()

  const { data: existingVision } = await supabase
    .from('caye_goals')
    .select('id')
    .eq('scope', 'operator')
    .eq('kind', 'vision')
    .is('superseded_at', null)
    .limit(1)
    .maybeSingle()

  if (existingVision) return { created: false, reason: 'an operator-scope vision already exists' }

  const provenance = { createdByKind: 'founder' as GoalCreatedByKind, createdByUserId, source: 'seed:starter-direction' }

  const { goal: vision, error: visionError } = await createGoal({
    kind: 'vision',
    scope: 'operator',
    title: 'Build Caye into a highly autonomous operating intelligence.',
    description:
      'Long-term direction for Caye as a product and as an operating entity: a persistent intelligence that ' +
      'understands objectives across business, personal, and research domains, and continuously makes safe, ' +
      'measurable progress toward them within its authorized authority.',
    status: 'active',
    priority: 'high',
    ...provenance,
    rationale: 'Top of the goal chain — every domain, objective, and goal below traces back to this.',
  })
  if (!vision) return { created: false, reason: visionError ?? 'failed to create vision' }

  const { goal: business } = await createGoal({
    kind: 'domain', scope: 'operator', parentId: vision.id,
    title: 'Business', description: 'Caye Inc. and future ventures.', status: 'active', priority: 'high', ...provenance,
  })
  const { goal: personal } = await createGoal({
    kind: 'domain', scope: 'operator', parentId: vision.id,
    title: 'Personal', description: 'Personal operations capability.', status: 'future', priority: 'medium', ...provenance,
  })
  const { goal: research } = await createGoal({
    kind: 'domain', scope: 'operator', parentId: vision.id,
    title: 'Research', description: 'Artificial intelligence, robotics, energy.', status: 'active', priority: 'medium', ...provenance,
  })

  if (business) {
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: business.id,
      title: "Make Caye economically sustainable.", status: 'active', priority: 'critical', ...provenance,
    })
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: business.id,
      title: "Increase Caye's operational autonomy.", status: 'active', priority: 'high', ...provenance,
    })
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: business.id,
      title: 'Validate Caye operating real businesses with decreasing human intervention.',
      status: 'active', priority: 'high', ...provenance,
    })
  }

  if (personal) {
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: personal.id,
      title: 'Future personal operations capability.', status: 'future', priority: 'low', ...provenance,
    })
  }

  if (research) {
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: research.id,
      title: 'Artificial intelligence.', description: 'Active, near-term research focus.',
      status: 'active', priority: 'medium', ...provenance,
    })
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: research.id,
      title: 'Robotics.', description: 'Future research focus, gated on business + autonomy thresholds.',
      status: 'future', priority: 'low', activationConditions: ROBOTICS_ACTIVATION, ...provenance,
    })
    await createGoal({
      kind: 'objective', scope: 'operator', parentId: research.id,
      title: 'Energy.', description: 'Future research focus.', status: 'future', priority: 'low', ...provenance,
    })
  }

  return { created: true, visionId: vision.id }
}
