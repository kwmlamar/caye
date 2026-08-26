import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveGroundedService } from '../service-grounding'
import type { ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

/**
 * writers/availability-writer.ts
 *
 * Recurring rules → service_availability_rules, upserted on
 * (workspace_id, service_id, weekday, effect) — same conflict key
 * add_service_availability_rule.ts already upserts on, so a correction to
 * an existing rule updates in place rather than stacking a second row.
 *
 * Date-scoped rules → service_date_overrides (new table), upserted on
 * (workspace_id, service_id, date_iso, effect) for the same reason. This is
 * the mechanism that keeps "only private available Sept 5" from ever
 * generalizing into a standing rule — it can ONLY be reached when
 * route-decision resolved scope.kind === 'date_scoped' with a real dateISO.
 */
export async function writeAvailabilityRecurring(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
  operatorText: string
}): Promise<WriteOutcome> {
  const payload = args.classification.availabilityRecurring
  if (!payload) return { decision: 'error', reason: 'destination availability_recurring but no payload' }

  const supabase = createServiceClient()
  const lookup = await resolveGroundedService(supabase, args.workspaceId, payload.serviceName, args.operatorText)
  if (!lookup.ok || !lookup.service) return { decision: 'candidate', reason: `service resolution failed: ${lookup.error}` }

  const { data, error } = await supabase
    .from('service_availability_rules')
    .upsert(
      {
        workspace_id: args.workspaceId,
        service_id: lookup.service.id,
        weekday: payload.weekday,
        effect: payload.effect,
        min_party: payload.minParty,
        note: payload.note,
        created_by: `${args.callerRole} (operator-learning-router)`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,service_id,weekday,effect' }
    )
    .select('id')
    .single()
  if (error) return { decision: 'error', reason: `availability rule upsert failed: ${error.message}` }

  return {
    decision: 'written',
    targetTable: 'service_availability_rules',
    targetRecordId: data?.id ?? '',
    supersededRecordId: null,
    reason: `set ${payload.effect} rule for ${lookup.service.name}`,
  }
}

export async function writeAvailabilityDate(args: {
  workspaceId: string
  callerRole: string
  classification: ClassificationResult
  operatorText: string
}): Promise<WriteOutcome> {
  const payload = args.classification.availabilityDate
  if (!payload) return { decision: 'error', reason: 'destination availability_date but no payload' }

  const supabase = createServiceClient()
  const lookup = await resolveGroundedService(supabase, args.workspaceId, payload.serviceName, args.operatorText)
  if (!lookup.ok || !lookup.service) return { decision: 'candidate', reason: `service resolution failed: ${lookup.error}` }

  const { data, error } = await supabase
    .from('service_date_overrides')
    .upsert(
      {
        workspace_id: args.workspaceId,
        service_id: lookup.service.id,
        date_iso: payload.dateISO,
        effect: payload.effect,
        min_party: payload.minParty,
        restricted_variant: payload.restrictedVariant,
        note: payload.note,
        created_by: `${args.callerRole} (operator-learning-router)`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,service_id,date_iso,effect' }
    )
    .select('id')
    .single()
  if (error) return { decision: 'error', reason: `date override upsert failed: ${error.message}` }

  return {
    decision: 'written',
    targetTable: 'service_date_overrides',
    targetRecordId: data?.id ?? '',
    supersededRecordId: null,
    reason: `set ${payload.effect} override for ${lookup.service.name} on ${payload.dateISO}`,
  }
}
