/**
 * Job-search operator (CAY-194 / #194) — application-execution rollout
 * controls.
 *
 * job_search_execution_settings is a singleton row (id is always `true`),
 * seeded fully OFF by the migration: automation_enabled=false, dry_run=true,
 * daily_submission_cap=3, emergency_paused=false. This is independent of
 * job_search_settings.paused (which only gates whether an application gets
 * PREPARED at all) — an application can be PREPARED while execution stays
 * fully disabled, which is exactly the current default state and the state
 * this PR ships in.
 *
 * Every flag that makes execution MORE capable of a real submission
 * (enabling automation, turning dry_run off, raising the cap) is only ever
 * flipped by a gateAdminHighRisk-wrapped Admin Shell tool requiring explicit
 * founder confirmation. Flags that make it safer (disabling automation,
 * turning dry_run on, emergency pause) are low-risk/immediate — see
 * lib/caye-agent/tools/admin/write-low and write-high for the asymmetry.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { logJobSearchEvent } from '../events'

export type ExecutionRolloutSettings = {
  automationEnabled: boolean
  dryRun: boolean
  dailySubmissionCap: number
  allowlistedProviders: string[]
  allowlistedEmployerDomains: string[]
  emergencyPaused: boolean
}

const FAIL_CLOSED_SETTINGS: ExecutionRolloutSettings = {
  automationEnabled: false,
  dryRun: true,
  dailySubmissionCap: 0,
  allowlistedProviders: [],
  allowlistedEmployerDomains: [],
  emergencyPaused: true,
}

export async function getExecutionRolloutSettings(): Promise<ExecutionRolloutSettings> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_execution_settings')
    .select('automation_enabled, dry_run, daily_submission_cap, allowlisted_providers, allowlisted_employer_domains, emergency_paused')
    .eq('id', true)
    .maybeSingle()

  if (error || !data) {
    // Fail closed: if settings can't be read, execution must behave as if
    // maximally restricted, never as if defaults/unrestricted apply.
    return { ...FAIL_CLOSED_SETTINGS }
  }

  return {
    automationEnabled: data.automation_enabled,
    dryRun: data.dry_run,
    dailySubmissionCap: data.daily_submission_cap,
    allowlistedProviders: Array.isArray(data.allowlisted_providers) ? data.allowlisted_providers : [],
    allowlistedEmployerDomains: Array.isArray(data.allowlisted_employer_domains) ? data.allowlisted_employer_domains : [],
    emergencyPaused: data.emergency_paused,
  }
}

async function updateSettings(patch: Record<string, unknown>, actor: string, eventPayload: Record<string, unknown>): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('job_search_execution_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true)
  if (error) throw new Error(`Could not update job-search execution settings: ${error.message}`)
  await logJobSearchEvent({ eventType: 'settings_changed', entityType: 'settings', payload: eventPayload, createdBy: actor })
}

export async function setAutomationEnabled(enabled: boolean, actor: string): Promise<void> {
  await updateSettings({ automation_enabled: enabled }, actor, { execution_automation_enabled: enabled })
}

export async function setDryRun(dryRun: boolean, actor: string): Promise<void> {
  await updateSettings({ dry_run: dryRun }, actor, { execution_dry_run: dryRun })
}

export async function setDailySubmissionCap(cap: number, actor: string): Promise<void> {
  if (!Number.isInteger(cap) || cap < 0) throw new Error('Daily submission cap must be a non-negative integer.')
  await updateSettings({ daily_submission_cap: cap }, actor, { execution_daily_submission_cap: cap })
}

export async function setEmergencyPaused(paused: boolean, actor: string, reason?: string): Promise<void> {
  await updateSettings({ emergency_paused: paused }, actor, { execution_emergency_paused: paused, reason: reason ?? null })
}

export async function getRemainingDailySubmissionCapacity(): Promise<number> {
  const settings = await getExecutionRolloutSettings()
  const supabase = createServiceClient()
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { count, error } = await supabase
    .from('job_search_applications')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'SUBMITTED')
    .gte('submitted_at', todayStart.toISOString())

  if (error) return 0
  const usedToday = count ?? 0
  return Math.max(0, settings.dailySubmissionCap - usedToday)
}
