import 'server-only'

import { findTool, TOOL_REGISTRY } from '@/lib/caye-agent/tools/registry'
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
  remove_business_fact: 'destructive_production_change',
  remove_standing_rule: 'destructive_production_change',
}

export function executableRecommendationCapabilities() {
  return TOOL_REGISTRY
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

function validateSchema(value: unknown, schemaValue: unknown, path = 'arguments'): string[] {
  const schema = objectValue(schemaValue)
  if (!schema) return []
  const errors: string[] = []

  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => validateSchema(value, candidate, path).length === 0)) errors.push(`${path} does not match any allowed schema`)
    return errors
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((candidate) => validateSchema(value, candidate, path).length === 0).length !== 1) errors.push(`${path} must match exactly one allowed schema`)
    return errors
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) errors.push(`${path} is not an allowed value`)
  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path} must equal the canonical constant`)

  const type = schema.type
  if (type === 'object') {
    const object = objectValue(value)
    if (!object) return [`${path} must be an object`]
    const properties = objectValue(schema.properties) ?? {}
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []
    for (const key of required) if (!(key in object)) errors.push(`${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`)
    }
    for (const [key, child] of Object.entries(object)) if (key in properties) errors.push(...validateSchema(child, properties[key], `${path}.${key}`))
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} has too few items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} has too many items`)
    if (schema.items) value.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items, `${path}[${index}]`)))
  } else if (type === 'string') {
    if (typeof value !== 'string') return [`${path} must be a string`]
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is too short`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is too long`)
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return [`${path} must be a ${type}`]
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} exceeds maximum`)
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`)
  }
  return errors
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

  const tool = findTool(raw.capabilityKey.trim())
  if (!tool) throw new Error('recommendation action plan references an unregistered capability')
  if (tool.risk !== 'low') throw new Error('recommendation action plan cannot directly execute a high-risk capability')
  if (!tool.roles.includes('founder') || !tool.modes.includes('back-office')) throw new Error('recommendation action capability is not available to the bounded internal runtime')
  const schemaErrors = validateSchema(args, tool.inputSchema)
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
  return FOUNDER_ONLY_BY_TOOL[plan.capabilityKey] ?? 'routine'
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
    allowedActions: [plan.capabilityKey],
    maxExternalRecipients: 1,
    maxRecordsAffected: 1,
    maxFinancialImpactCents: 0,
    auditExternalActions: true,
  }
}

export function toolForRecommendationPlan(plan: RecommendationActionPlan): Tool<never> {
  const tool = findTool(plan.capabilityKey)
  if (!tool) throw new Error('registered recommendation capability disappeared')
  if (tool.risk !== 'low' || !tool.roles.includes('founder') || !tool.modes.includes('back-office')) throw new Error('recommendation capability is no longer low-risk and executable')
  validateRecommendationActionPlan(plan)
  return tool
}
