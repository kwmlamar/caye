/**
 * Pure matching rules behind the migration-drift watchdog
 * (lib/db/migration-drift.ts). Kept free of 'server-only' and any Supabase
 * import so the interesting logic — which is all in the name matching — is
 * directly testable.
 *
 * The load-bearing rule is EXACT-NAME matching: a migration is applied when
 * the ledger holds a row whose name is the repo basename. Everything else in
 * this file exists to tolerate ledger rows written before that convention was
 * enforced (see scripts/check-migration-ledger.mjs), and is deliberately
 * constrained so it can never *mask* a genuinely missing migration.
 */

/**
 * Migrations verified applied by checking that the DB objects / constraints
 * they create actually exist, but recorded in schema_migrations under a
 * different name than their filename. They predate the convention of using
 * the filename as the migration name — e.g. 20260611_eod_summary.sql was
 * recorded as "eod_summary_schedule".
 *
 * Without this, every one of them would false-positive forever and train
 * whoever gets the alert to ignore it — which is precisely how the real
 * gaps stayed invisible for weeks. Nothing should be added here without
 * first confirming from production evidence that the migration's effect is
 * present.
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
  // 2026-08-20 reconciliation: both were deployed before the migration-history
  // naming convention stabilized. The payment_setup_needed queue kind is
  // independently visible in the live DB constraint; cron-run history has
  // been used by deployed operational telemetry without missing-relation
  // failures. Keep them as exact legacy exceptions rather than weakening the
  // matcher for future letter-suffixed migrations.
  '20260813d_add_payment_setup_needed_outbound_kind',
  '20260813g_cron_run_history',
])

/**
 * The repo's migration filename prefix, in one place.
 *
 * Derived from every basename actually present in supabase/migrations (219
 * files as of 2026-09-02), not from any single incident:
 *
 *   <date-time><disambiguator>_<slug>
 *
 *   date-time     8, 10, 12 or 14 digits — a calendar date, optionally
 *                 carrying time to hour / minute / second precision:
 *                   20260728_…          YYYYMMDD        (97 files)
 *                   202608301901_…      YYYYMMDDHHMM     (1 file)
 *                   20260814163945_…    YYYYMMDDHHMMSS  (37 files)
 *   disambiguator 0-2 lowercase letters, for several migrations authored the
 *                 same day:
 *                   20260721e_…         (83 files)
 *                   20260828zz_…        (1 file)
 *
 * The previous expression — /^(?:\d{14}|\d{8}[a-z]?)_/ — covered neither the
 * 12-digit nor the two-letter form, so 20260828zz_property_telemetry_v1 and
 * 202608301901_effect_verification_runtime_compat could never match their
 * (correctly named) ledger rows and false-positived on every drift check.
 *
 * Anchored and length-bounded on purpose: a 7- or 9-digit run, three or more
 * letters, uppercase, or digits appearing anywhere but the start are NOT a
 * migration prefix and must survive untouched, so a ledger slug that merely
 * contains digits is never mangled into a false match.
 */
export const MIGRATION_PREFIX = /^\d{8}(?:\d{2}|\d{4}|\d{6})?[a-z]{0,2}_/

/**
 * Strips the migration date/timestamp prefix. Returns the input unchanged
 * when it carries no recognised prefix.
 */
export function slugOf(basename: string): string {
  return basename.replace(MIGRATION_PREFIX, '')
}

/**
 * Slugs shared by more than one repo migration.
 *
 * The slug fallback is only safe while slugs are unique. If two migrations
 * reduce to the same slug, one ledger row would satisfy both, and a genuinely
 * missing migration would be reported as applied — a false negative, which is
 * strictly worse than the false positives this file exists to remove.
 *
 * findMissingMigrations consults this at call time and withholds the fallback
 * from any colliding name, so the failure mode of a future collision is a
 * noisy false positive rather than silent masking. The repo currently has
 * zero collisions and a test asserts that stays true.
 */
export function findSlugCollisions(
  repoMigrations: readonly string[]
): Map<string, string[]> {
  const bySlug = new Map<string, string[]>()
  for (const name of repoMigrations) {
    const slug = slugOf(name)
    const bucket = bySlug.get(slug)
    if (bucket) bucket.push(name)
    else bySlug.set(slug, [name])
  }
  for (const [slug, names] of bySlug) {
    if (names.length < 2) bySlug.delete(slug)
  }
  return bySlug
}

/**
 * Repo migrations with no corresponding entry in the DB's applied ledger.
 *
 * Match order:
 *   1. the exact basename — the only mechanism new migrations should ever
 *      need, and the one scripts/check-migration-ledger.mjs enforces;
 *   2. the prefix-stripped slug, for ledger rows written before that
 *      convention, and only when the slug is unambiguous in the repo;
 *   3. LEGACY_RECONCILED, for rows whose recorded name resembles nothing.
 */
export function findMissingMigrations(
  repoMigrations: readonly string[],
  appliedNames: Iterable<string>
): string[] {
  const applied = new Set(appliedNames)
  const ambiguous = findSlugCollisions(repoMigrations)

  return repoMigrations.filter((name) => {
    if (applied.has(name)) return false
    if (LEGACY_RECONCILED.has(name)) return false
    const slug = slugOf(name)
    // A colliding slug proves nothing about THIS migration, so it is not
    // allowed to clear it.
    if (ambiguous.has(slug)) return true
    return !applied.has(slug)
  })
}
