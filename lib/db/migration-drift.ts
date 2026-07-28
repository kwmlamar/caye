import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { REPO_MIGRATIONS } from './migration-manifest'
import { findMissingMigrations } from './migration-match'

/**
 * Dead-man's switch for hand-applied migrations.
 *
 * Migrations here are applied by hand against the hosted DB, and nothing
 * ever checked that the repo and the database agreed. Three separate
 * migrations sat written-but-never-applied for weeks each, every one
 * surfacing only as a confusing user-visible failure:
 *
 *   - 20260721e_caye_admin_pending_actions — Admin Shell's high-risk gate
 *     table. Missing 7 days; trigger_cron simply errored for anyone who
 *     tried it.
 *   - 20260524_add_ai_enabled_to_workspace_ai_config — missing 2 months.
 *     PostgREST 400s the *whole* query when one selected column doesn't
 *     exist, so every `.select('system_prompt, ai_enabled')` across the
 *     Instagram/Messenger/Zoho/nudge-scan paths failed outright, taking
 *     system_prompt down with it and failing open.
 *   - 20260725b_customers_nullable_signup_fields — missing 2 days, during
 *     which every WhatsApp-first signup hit a NOT NULL violation and got
 *     told "I couldn't find your account."
 *
 * This compares the repo's migration filenames (baked in at build time —
 * see migration-manifest.ts) against the DB's own ledger, so the next one
 * announces itself within the hour instead of after a customer notices.
 */

export interface MigrationDriftResult extends Record<string, unknown> {
  ok: boolean
  missing: string[]
  repo_count: number
  applied_count: number
  error?: string
}

export async function checkMigrationDrift(): Promise<MigrationDriftResult> {
  const supabase = createServiceClient()

  // supabase_migrations isn't exposed through PostgREST — this RPC is a
  // service-role-only reader over it (20260728b_applied_migration_names_rpc).
  const { data, error } = await supabase.rpc('applied_migration_names')

  if (error) {
    return {
      ok: false,
      missing: [],
      repo_count: REPO_MIGRATIONS.length,
      applied_count: 0,
      error: `applied_migration_names rpc failed: ${error.message}`,
    }
  }

  const applied = (data as string[] | null) ?? []
  const missing = findMissingMigrations(REPO_MIGRATIONS, applied)

  return {
    ok: missing.length === 0,
    missing,
    repo_count: REPO_MIGRATIONS.length,
    applied_count: new Set(applied).size,
  }
}

const ALERT_COOLDOWN_HOURS = 12

/**
 * Best-effort — never throws. Called from the hourly escalation-followup
 * cron, the same opportunistic-piggyback pattern checkStaleCronsAndAlert
 * uses, rather than being its own cron: a cron that watches for problems
 * shouldn't have its own separate registration to silently stop running.
 *
 * Alerts by email as well as WhatsApp. A missing migration can be exactly
 * what breaks WhatsApp sending, so alerting only over WhatsApp risks the
 * failure suppressing its own alarm.
 */
export async function checkMigrationDriftAndAlert(): Promise<MigrationDriftResult | null> {
  try {
    const result = await checkMigrationDrift()
    if (result.ok && !result.error) return result

    const supabase = createServiceClient()
    const bucket = Math.floor(Date.now() / (ALERT_COOLDOWN_HOURS * 60 * 60 * 1000))
    const alertKey = `migration-drift-${bucket}`

    const { error: dedupErr } = await supabase
      .from('caye_founder_alert_log')
      .insert({ alert_key: alertKey })
    if (dedupErr) {
      if (dedupErr.code === '23505') return result // already alerted this window
      console.error('[migration-drift] dedup insert failed:', dedupErr)
      return result
    }

    const body = result.error
      ? `⚠️ Migration drift check itself failed — ${result.error}`
      : `⚠️ ${result.missing.length} migration(s) in the repo have never been applied to the database: ${result.missing.join(', ')}. Apply them before the next deploy — code that depends on them is already live.`

    const { data: settings } = await supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', ['founder_phone', 'founder_email'])

    const byKey = new Map((settings ?? []).map((r) => [r.key as string, r.value as string]))

    const email = byKey.get('founder_email')
    if (email) {
      const { sendFounderAlertEmail } = await import('@/lib/email/founder-mailer')
      const emailResult = await sendFounderAlertEmail({
        to: email,
        subject: 'Caye: unapplied database migrations',
        body,
      })
      if (!emailResult.ok) console.error('[migration-drift] email failed:', emailResult.error)
    }

    const phone = byKey.get('founder_phone')
    if (phone) {
      const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
      const waResult = await sendFreeFormWhatsApp(phone, body, alertKey)
      if (waResult.status === 'failed') {
        console.error('[migration-drift] whatsapp alert failed:', waResult.error)
      }
    }

    return result
  } catch (err) {
    console.error('[migration-drift] check failed:', err)
    return null
  }
}
