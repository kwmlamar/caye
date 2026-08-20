import { describe, it, expect } from 'vitest'
import { findMissingMigrations, slugOf, LEGACY_RECONCILED } from './migration-match'
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
  // of the 2026-07-28 audit. Simulating a ledger that contains each
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
