import 'server-only'

import { findTool, TOOL_REGISTRY } from '@/lib/caye-agent/tools/registry'
import { validateToolArgumentsAgainstSchema } from '@/lib/caye-agent/tools/schema-validation'
import type { Tool } from '@/lib/caye-agent/tools/types'
import type { ActionAutonomyContext, WorkspaceAutonomyPolicy } from '@/lib/action-autonomy'
import type { RecommendationActionKind } from './decisions'

export type RecommendationActionMateriality = 'quiet' | 'material' | 'consequential'

export type RecommendationActionPlan = {
  capabilityKey: string
  operation: 'execute'
  arguments: Record<string, unknown>
  expectedEffect: string
  preconditions: string[]
  materiality: RecommendationActionMateriality
}

const FOUNDER_ONLY_BY_TOOL: Record<string, RecommendationActionKind> = {
  send_payment_confirmation: 'payment_or_money_movement',
  notify_driver: 'consequential_customer_communication',
  create_outreach_leads: 'sensitive_outreach',
  run_outreach: 'sensitive_outreach',
  update_team_member_permissions: 'auth_security_authority_change',
  add_team_member: 'auth_security_authority_change',
  switch_workspace: 'auth_security_authority_change',
  remove_business_fact: 'destructive_production_change',
  remove_standing_rule: 'destructive_production_change',
}

/**
 * Recommendation autonomy is stricter than the generic tool `risk` flag.
 *
 * A capability belongs here only after it has both:
 * 1. a code-owned recommendation authority/impact classification, and
 * 2. replay-safe idempotency tied to the durable recommendation execution key.
 *
 * None of the current write-low tools satisfy that full contract yet. Keeping
 * this set empty is deliberate: recommendations remain useful/advisory while
 * autonomous effects fail closed instead of inheriting permission from a
 * generic `risk: low` label.
 */
const AUTONOMOUS_RECOMMENDATION_CAPABILITIES = new Set<string>()

export function isAutonomousRecommendationCapability(capabilityKey: string): boolean {
  return AUTONOMOUS_RECOMMENDATION_CAPABILITIES.has(capabilityKey)
}

export function executableRecommendationCapabilities() {
  return TOOL_REGISTRY
    .filter((tool) => isAutonomousRecommendationCapability(tool.name))
    .filter((tool) => tool.risk === 'low' && tool.roles.includes('founder') && tool.modes.includes('back-office'))
    .map((tool) => ({
      capabilityKey: tool.name,
      operation: 'execute' as const,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey))
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function validateRecommendationActionPlan(value: unknown): RecommendationActionPlan {
  const raw = objectValue(value)
  if (!raw) throw new Error('recommendation action plan must be an object')
  if (typeof raw.capabilityKey !== 'string' || !raw.capabilityKey.trim()) throw new Error('recommendation action plan capabilityKey is required')
  if (raw.operation !== 'execute') throw new Error('recommendation action plan operation must be execute')
  const args = objectValue(raw.arguments)
  if (!args) throw new Error('recommendation action plan arguments must be an object')
  if (typeof raw.expectedEffect !== 'string' || raw.expectedEffect.trim().length < 8) throw new Error('recommendation action plan expectedEffect is required')
  if (!Array.isArray(raw.preconditions) || raw.preconditions.some((entry) => typeof entry !== 'string')) throw new Error('recommendation action plan preconditions must be strings')
  if (!['quiet', 'material', 'consequential'].includes(String(raw.materiality))) throw new Error('recommendation action plan materiality is invalid')

  const capabilityKey = raw.capabilityKey.trim()
  const tool = findTool(capabilityKey)
  if (!tool) throw new Error('recommendation action plan references an unregistered capability')
  if (!isAutonomousRecommendationCapability(tool.name)) {
    throw new Error('recommendation capability is not explicitly approved for autonomous replay-safe execution')
  }
  if (tool.risk !== 'low') throw new Error('recommendation action plan cannot directly execute a high-risk capability')
  if (!tool.roles.includes('founder') || !tool.modes.includes('back-office')) throw new Error('recommendation action capability is not available to the bounded internal runtime')
  const schemaErrors = validateToolArgumentsAgainstSchema(args, tool.inputSchema)
  if (schemaErrors.length) throw new Error(`recommendation action arguments are invalid: ${schemaErrors.slice(0, 4).join('; ')}`)

  return {
    capabilityKey: tool.name,
    operation: 'execute',
    arguments: args,
    expectedEffect: raw.expectedEffect.trim(),
    preconditions: raw.preconditions.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 12),
    materiality: raw.materiality as RecommendationActionMateriality,
  }
}

export function actionKindForRecommendationPlan(plan: RecommendationActionPlan): RecommendationActionKind {
  // Unknown/unclassified capability semantics never default to routine.
  return FOUNDER_ONLY_BY_TOOL[plan.capabilityKey] ?? 'auth_security_authority_change'
}

export function actionContextForRecommendationPlan(plan: RecommendationActionPlan, hasExistingAuthorization: boolean): ActionAutonomyContext {
  return {
    action: plan.capabilityKey,
    reversibility: 'reversible',
    evidenceSufficient: plan.preconditions.length > 0,
    hasExistingAuthorization,
    externalCommunication: ['send_operator_message', 'notify_driver', 'send_payment_confirmation', 'run_outreach'].includes(plan.capabilityKey),
    destructive: ['remove_business_fact', 'remove_standing_rule'].includes(plan.capabilityKey),
    financialImpactCents: 0,
    affectedRecords: 1,
    affectedPeople: ['send_operator_message', 'notify_driver', 'send_payment_confirmation'].includes(plan.capabilityKey) ? 1 : 0,
  }
}

export function workspacePolicyForRecommendationPlan(plan: RecommendationActionPlan): WorkspaceAutonomyPolicy {
  return {
    allowedActions: isAutonomousRecommendationCapability(plan.capabilityKey) ? [plan.capabilityKey] : [],
    maxExternalRecipients: 1,
    maxRecordsAffected: 1,
    maxFinancialImpactCents: 0,
    auditExternalActions: true,
  }
}

export function toolForRecommendationPlan(plan: RecommendationActionPlan): Tool<never> {
  const tool = findTool(plan.capabilityKey)
  if (!tool) throw new Error('registered recommendation capability disappeared')
  if (!isAutonomousRecommendationCapability(tool.name)) throw new Error('recommendation capability is not approved for autonomous execution')
  if (tool.risk !== 'low' || !tool.roles.includes('founder') || !tool.modes.includes('back-office')) throw new Error('recommendation capability is no longer low-risk and executable')
  validateRecommendationActionPlan(plan)
  return tool
}
