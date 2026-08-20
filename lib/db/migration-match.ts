/**
 * Pure matching rules behind the migration-drift watchdog
 * (lib/db/migration-drift.ts). Kept free of 'server-only' and any Supabase
 * import so the interesting logic — which is all in the name matching — is
 * directly testable.
 */

/**
 * Migrations verified applied on 2026-07-28 by checking that the DB objects
 * they create actually exist, but recorded in schema_migrations under a
 * different name than their filename. They predate the convention of using
 * the filename as the migration name — e.g. 20260611_eod_summary.sql was
 * recorded as "eod_summary_schedule".
 *
 * Without this, every one of them would false-positive forever and train
 * whoever gets the alert to ignore it — which is precisely how the real
 * gaps stayed invisible for weeks. Nothing should be added here without
 * first confirming in the database that the migration's objects are present.
 */
export const LEGACY_RECONCILED: ReadonlySet<string> = new Set([
  '20260527_add_metadata_to_workspace_ai_config', // → metadata column present
  '20260609_voice_alignment', // → voice_alignment_confirmed_at
  '20260611_eod_summary', // → eod_summary_schedule
  '20260611_morning_briefing', // → morning_briefing_schedule
  '20260622_operator_identity_and_shadow', // → operator_identity_and_shadow_20260622
  '20260703_caye_escalations_founder_tier', // → founder_escalated_at column present
  '20260703b_bookings_payment_and_reminders', // → payment/reminder columns present
  '20260721b_morning_digest_aging_escalations_placeholder', // data-only; template row updated
  '20260723b_team_consent_template', // → team_consent_template_seed
])

/**
 * Strips the migration date/timestamp prefix.
 *
 * Supports both naming conventions present in this repo:
 *   20260728b_foo_bar        → foo_bar
 *   20260814163945_foo_bar   → foo_bar
 */
export function slugOf(basename: string): string {
  return basename.replace(/^(?:\d{14}|\d{8}[a-z]?)_/, '')
}

/**
 * Repo migrations with no corresponding entry in the DB's applied ledger.
 *
 * Matches on the full filename first, then the date/timestamp-stripped slug,
 * because the ledger holds both shapes: older/manual applies were often
 * recorded as bare slugs while others retain the full filename.
 */
export function findMissingMigrations(
  repoMigrations: readonly string[],
  appliedNames: Iterable<string>
): string[] {
  const applied = new Set(appliedNames)
  return repoMigrations.filter(
    (name) => !applied.has(name) && !applied.has(slugOf(name)) && !LEGACY_RECONCILED.has(name)
  )
}
