import { describe, it, expect } from 'vitest'
import {
  findMissingMigrations,
  findSlugCollisions,
  slugOf,
  LEGACY_RECONCILED,
  MIGRATION_PREFIX,
} from './migration-match'
import { REPO_MIGRATIONS } from './migration-manifest'

describe('slugOf', () => {
  it('strips a plain date prefix', () => {
    expect(slugOf('20260728_ensure_founder_in_workspace_members')).toBe(
      'ensure_founder_in_workspace_members'
    )
  })

  it('strips a date prefix with a same-day letter suffix', () => {
    expect(slugOf('20260721e_caye_admin_pending_actions')).toBe('caye_admin_pending_actions')
  })

  it('strips a full timestamp prefix', () => {
    expect(slugOf('20260814163945_caye_authorizations_and_jobs')).toBe(
      'caye_authorizations_and_jobs'
    )
  })

  it('leaves an already-bare slug alone', () => {
    expect(slugOf('caye_cron_runs')).toBe('caye_cron_runs')
  })

  it('does not strip digits that are not a date prefix', () => {
    expect(slugOf('seed_email_test_asset_V4_1774612353000')).toBe(
      'seed_email_test_asset_V4_1774612353000'
    )
  })
})

describe('findMissingMigrations', () => {
  it('matches on the full filename', () => {
    expect(findMissingMigrations(['20260728_foo'], ['20260728_foo'])).toEqual([])
  })

  it('matches on the date-stripped slug, for ledger entries recorded the old way', () => {
    expect(findMissingMigrations(['20260611_eod_summary'], ['eod_summary'])).toEqual([])
  })

  it('matches timestamped filenames against bare ledger slugs', () => {
    expect(
      findMissingMigrations(
        ['20260814163945_caye_authorizations_and_jobs'],
        ['caye_authorizations_and_jobs']
      )
    ).toEqual([])
  })

  it('reports a migration the ledger has never heard of', () => {
    expect(findMissingMigrations(['20260728_foo'], ['something_else'])).toEqual(['20260728_foo'])
  })

  it('suppresses the verified legacy-name mismatches', () => {
    const legacy = '20260611_morning_briefing'
    expect(LEGACY_RECONCILED.has(legacy)).toBe(true)
    expect(findMissingMigrations([legacy], [])).toEqual([])
  })

  it.each([
    '20260813d_add_payment_setup_needed_outbound_kind',
    '20260813g_cron_run_history',
  ])('suppresses the verified Aug 13 ledger mismatch %s', (name) => {
    expect(LEGACY_RECONCILED.has(name)).toBe(true)
    expect(findMissingMigrations([name], [])).toEqual([])
  })

  it('does not let a legacy entry mask an unrelated missing migration', () => {
    const result = findMissingMigrations(['20260611_morning_briefing', '20260728_brand_new'], [])
    expect(result).toEqual(['20260728_brand_new'])
  })

  it('handles an empty ledger without throwing', () => {
    expect(() => findMissingMigrations(REPO_MIGRATIONS, [])).not.toThrow()
  })

  // The four that were actually found missing on 2026-07-28, each after it
  // had already broken something in production. None are in
  // LEGACY_RECONCILED, so a future recurrence must still be reported.
  it.each([
    '20260721e_caye_admin_pending_actions',
    '20260524_add_ai_enabled_to_workspace_ai_config',
    '20260726_bookings_payment_link',
    '20260703_contacts_channel_identity_unique',
  ])('still reports %s when absent from the ledger', (name) => {
    expect(LEGACY_RECONCILED.has(name)).toBe(false)
    expect(findMissingMigrations([name], ['unrelated'])).toEqual([name])
  })
})

describe('the repo manifest against a fully-reconciled ledger', () => {
  // Every repo migration matched either by name or via LEGACY_RECONCILED as
  // of the migration audits. Simulating a ledger that contains each
  // migration's slug proves the manifest and matcher agree.
  it('reports no drift when the ledger holds every slug', () => {
    const ledger = REPO_MIGRATIONS.map(slugOf)
    expect(findMissingMigrations(REPO_MIGRATIONS, ledger)).toEqual([])
  })

  it('every LEGACY_RECONCILED entry is a real repo migration', () => {
    // Guards against the allowlist rotting into a set of names that silently
    // suppress nothing (or worse, mask a renamed file).
    for (const name of LEGACY_RECONCILED) {
      expect(REPO_MIGRATIONS).toContain(name)
    }
  })
})

describe('slugOf across every filename shape in the repo', () => {
  // Derived from the shapes actually present in supabase/migrations, not from
  // the two filenames that happened to trigger the 2026-09-02 incident.
  it.each([
    // [filename, expected slug, why this shape exists]
    ['20260728_ensure_founder_in_workspace_members', 'ensure_founder_in_workspace_members', 'date only'],
    ['20260721e_caye_admin_pending_actions', 'caye_admin_pending_actions', 'date + one-letter suffix'],
    ['20260828zz_property_telemetry_v1', 'property_telemetry_v1', 'date + two-letter suffix'],
    ['2026083012_some_change', 'some_change', 'date + hour'],
    ['202608301901_effect_verification_runtime_compat', 'effect_verification_runtime_compat', '12-digit date + hour/minute'],
    ['20260814163945_caye_authorizations_and_jobs', 'caye_authorizations_and_jobs', '14-digit full timestamp'],
    ['2026083019011_odd', '2026083019011_odd', '13 digits is not a recognised precision'],
  ])('%s -> %s (%s)', (name, expected) => {
    expect(slugOf(name)).toBe(expected)
  })

  it.each([
    'caye_cron_runs',
    'seed_email_test_asset_V4_1774612353000',
    'expand_channel_type_enum_only_part_1_1774612345000',
    '2026072_too_few_digits',
    '202607281_nine_digits',
    '20260721E_uppercase_suffix',
    '20260721abc_three_letter_suffix',
    '20260721-dash_separated',
    'v20260721_prefixed_by_a_letter',
  ])('leaves %s untouched', (name) => {
    expect(slugOf(name)).toBe(name)
    expect(MIGRATION_PREFIX.test(name)).toBe(false)
  })
})

describe('the exact filenames responsible for the 2026-09-02 incident', () => {
  // Both were applied and correctly recorded; only the matcher was wrong.
  // These two cases are the regression: if the prefix expression narrows
  // again, they go back to false-positiving forever.
  it.each([
    ['20260828zz_property_telemetry_v1', 'property_telemetry_v1'],
    ['202608301901_effect_verification_runtime_compat', 'effect_verification_runtime_compat'],
  ])('%s matches a ledger row recorded as its bare slug', (filename, ledgerSlug) => {
    expect(findMissingMigrations([filename], [ledgerSlug])).toEqual([])
  })

  it.each([
    '20260828zz_property_telemetry_v1',
    '202608301901_effect_verification_runtime_compat',
  ])('%s also matches the exact-filename row the reconciliation inserted', (filename) => {
    // The 2026-09-02 production repair recorded all 15 under their exact
    // basename. Those rows must satisfy the repaired matcher too.
    expect(findMissingMigrations([filename], [filename])).toEqual([])
  })

  it('still reports both when the ledger genuinely has neither', () => {
    const names = [
      '20260828zz_property_telemetry_v1',
      '202608301901_effect_verification_runtime_compat',
    ]
    expect(findMissingMigrations(names, ['something_unrelated'])).toEqual(names)
  })
})

describe('hand-entered ledger aliases and intentional squashes', () => {
  it('matches a squash: several repo migrations, one ledger row, exact names recorded later', () => {
    // 20260830g/h/i/j all went into production as the single ledger row
    // "perception_hardening_and_direction_bridge". Only exact-name rows can
    // clear them, which is what the reconciliation inserted.
    const squashed = [
      '20260830g_perception_telemetry_rejected_heartbeat',
      '20260830h_perception_suppress_out_of_order_events',
      '20260830i_perception_duplicate_scope_guard',
      '20260830j_perception_direction_evidence_bridge',
    ]
    expect(findMissingMigrations(squashed, ['perception_hardening_and_direction_bridge'])).toEqual(
      squashed
    )
    expect(findMissingMigrations(squashed, squashed)).toEqual([])
  })

  it('a hand-entered alias that resembles nothing does not clear a migration', () => {
    expect(
      findMissingMigrations(
        ['20260830_lock_perception_runtime_rpcs'],
        ['lock_perception_runtime_rpcs_to_service_role']
      )
    ).toEqual(['20260830_lock_perception_runtime_rpcs'])
  })

  it('schema-present-but-ledger-missing is reported, because only the ledger is consulted', () => {
    // The matcher deliberately knows nothing about live schema. A migration
    // whose objects exist but whose row is absent MUST still be reported, so
    // the gap gets an explicit reconciliation row rather than silence.
    expect(findMissingMigrations(['20260831_adaptive_research_cadence'], [])).toEqual([
      '20260831_adaptive_research_cadence',
    ])
  })
})

describe('the slug fallback cannot mask a missing migration', () => {
  it('withholds the fallback from ambiguous slugs', () => {
    // Two same-day migrations sharing a slug: one ledger row must not clear
    // both. Reporting a false positive is the correct failure here.
    const repo = ['20260901a_widget_sync', '20260902b_widget_sync']
    expect(findSlugCollisions(repo).get('widget_sync')).toEqual(repo)
    expect(findMissingMigrations(repo, ['widget_sync'])).toEqual(repo)
  })

  it('an exact-name row still clears one half of a colliding pair', () => {
    const repo = ['20260901a_widget_sync', '20260902b_widget_sync']
    expect(findMissingMigrations(repo, ['20260901a_widget_sync'])).toEqual([
      '20260902b_widget_sync',
    ])
  })

  it('the repo has no slug collisions today', () => {
    // If this fails, two migrations reduce to the same slug. Rename one; do
    // NOT relax the matcher.
    expect([...findSlugCollisions(REPO_MIGRATIONS).entries()]).toEqual([])
  })
})
