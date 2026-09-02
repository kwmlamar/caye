import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditLedgerIdentity,
  isReconciliationMarker,
  ledgerNameForMigrationFile,
  RECONCILIATION_MARKER_PREFIX,
} from './migration-identity'
import { LEGACY_RECONCILED, MIGRATION_PREFIX } from './migration-match'
import { REPO_MIGRATIONS } from './migration-manifest'

const SCRIPTS = join(__dirname, '..', '..', 'scripts')

describe('ledgerNameForMigrationFile', () => {
  it('derives the name from the filename, path and all', () => {
    expect(ledgerNameForMigrationFile('supabase/migrations/20260902120000_foo_bar.sql')).toBe(
      '20260902120000_foo_bar'
    )
    expect(ledgerNameForMigrationFile('20260828zz_property_telemetry_v1.sql')).toBe(
      '20260828zz_property_telemetry_v1'
    )
  })

  it.each([
    ['notes.md', 'not a .sql file'],
    ['migration.sql', 'no date prefix'],
    ['2026_short.sql', 'too few digits'],
    ['20260721ABC_upper.sql', 'uppercase suffix'],
  ])('refuses %s (%s)', (file) => {
    expect(() => ledgerNameForMigrationFile(file)).toThrow()
  })

  it('accepts every migration currently in the repo', () => {
    for (const name of REPO_MIGRATIONS) {
      expect(ledgerNameForMigrationFile(`${name}.sql`)).toBe(name)
    }
  })
})

describe('isReconciliationMarker', () => {
  it('recognises a dated reconciliation stamp', () => {
    expect(isReconciliationMarker('migration-drift-reconciliation-2026-09-02')).toBe(true)
  })

  it.each([null, undefined, '', 'classicalsineus@gmail.com', 'reconciliation'])(
    'rejects %s',
    (value) => {
      expect(isReconciliationMarker(value)).toBe(false)
    }
  )
})

describe('auditLedgerIdentity', () => {
  it('is silent when every migration is recorded under its exact filename', () => {
    const repoMigrations = ['20260901_alpha', '20260902_beta']
    const ledger = repoMigrations.map((name, i) => ({ version: `2026090212000${i}`, name }))
    expect(auditLedgerIdentity({ repoMigrations, ledger })).toEqual([])
  })

  it('reports a hand-entered alias — the class that caused the incident', () => {
    const findings = auditLedgerIdentity({
      repoMigrations: ['20260830_lock_perception_runtime_rpcs'],
      ledger: [{ version: '20260830202944', name: 'lock_perception_runtime_rpcs' }],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'alias',
      migration: '20260830_lock_perception_runtime_rpcs',
      recordedAs: 'lock_perception_runtime_rpcs',
    })
    expect(findings[0].detail).toContain('scripts/apply-migration.mjs')
  })

  it('reports a ledger row that names nothing in the repo', () => {
    const findings = auditLedgerIdentity({
      repoMigrations: ['20260901_alpha'],
      ledger: [
        { version: '20260901120000', name: '20260901_alpha' },
        { version: '20260902120000', name: 'perception_hardening_and_direction_bridge' },
      ],
    })
    expect(findings.map((f) => f.kind)).toEqual(['unknown-row'])
  })

  it('exempts rows carrying a reconciliation marker', () => {
    // The 2026-09-02 repair inserted 15 exact-name rows with this marker. They
    // match the repo exactly, so they raise nothing — but a marked row naming
    // something else is also tolerated as documented historical reconciliation.
    const findings = auditLedgerIdentity({
      repoMigrations: ['20260901_alpha'],
      ledger: [
        { version: '20260901120000', name: '20260901_alpha' },
        {
          version: '20260902130001',
          name: 'a_squash_of_four_perception_migrations',
          created_by: 'migration-drift-reconciliation-2026-09-02',
        },
      ],
    })
    expect(findings).toEqual([])
  })

  it('exempts pre-convention history below sinceVersion', () => {
    const ledger = [{ version: '20260318163519', name: 'add_stripe_columns_to_customers' }]
    expect(auditLedgerIdentity({ repoMigrations: [], ledger })).toHaveLength(1)
    expect(
      auditLedgerIdentity({ repoMigrations: [], ledger, sinceVersion: '20260901000000' })
    ).toEqual([])
  })

  it('reports the same name recorded twice', () => {
    const findings = auditLedgerIdentity({
      repoMigrations: ['20260901_alpha'],
      ledger: [
        { version: '20260901120000', name: '20260901_alpha' },
        { version: '20260901130000', name: '20260901_alpha' },
      ],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'duplicate-name', recordedAs: '20260901_alpha' })
  })

  it('does not flag a LEGACY_RECONCILED migration as an alias', () => {
    // 20260611_eod_summary is recorded as "eod_summary_schedule" and is a
    // known, verified historical exception.
    expect(
      auditLedgerIdentity({
        repoMigrations: ['20260611_eod_summary'],
        ledger: [{ version: '20260611120000', name: 'eod_summary' }],
      })
    ).toEqual([])
  })

  it('reproduces the 2026-09-02 aliases from the real ledger shape', () => {
    // The four squashed perception migrations plus the two renamed ones, as
    // they were recorded before the repair.
    const repoMigrations = [
      '20260830g_perception_telemetry_rejected_heartbeat',
      '20260830d_persistent_operating_memory',
      '20260829c_job_search_browser_execution',
    ]
    const ledger = [
      { version: '1', name: 'perception_hardening_and_direction_bridge' },
      { version: '2', name: 'persistent_operating_memory_with_scope_invariants' },
      { version: '3', name: 'job_search_browser_execution_reservations' },
    ]
    const findings = auditLedgerIdentity({ repoMigrations, ledger })
    // None of those aliases share a slug with their migration, so they surface
    // as unrecorded migrations plus unknown rows — which is exactly why only
    // exact-name rows could repair them.
    expect(findings.filter((f) => f.kind === 'unknown-row')).toHaveLength(3)
  })
})

describe('the scripts agree with the tested library', () => {
  // scripts/*.mjs cannot import the TypeScript modules, so they restate two
  // constants. If those ever diverge, the automation stops enforcing what the
  // watchdog checks — silently. Cheap guard.
  it.each(['apply-migration.mjs', 'check-migration-ledger.mjs'])(
    '%s uses the same migration prefix expression',
    (file) => {
      const text = readFileSync(join(SCRIPTS, file), 'utf8')
      const m = text.match(/const MIGRATION_PREFIX = (\/.*\/)\n/)
      expect(m, `${file} should declare MIGRATION_PREFIX`).toBeTruthy()
      expect(m![1]).toBe(MIGRATION_PREFIX.toString())
    }
  )

  it('check-migration-ledger.mjs uses the same reconciliation marker', () => {
    const text = readFileSync(join(SCRIPTS, 'check-migration-ledger.mjs'), 'utf8')
    expect(text).toContain(`'${RECONCILIATION_MARKER_PREFIX}'`)
  })

  it('check-migration-ledger.mjs prefers the richer RPC and names its fallback', () => {
    const text = readFileSync(join(SCRIPTS, 'check-migration-ledger.mjs'), 'utf8')
    expect(text).toContain('applied_migration_ledger')
    expect(text).toContain('applied_migration_names')
    // It must say what it could NOT check when running names-only, rather than
    // quietly downgrading — the overclaim this whole file exists to prevent.
    expect(text).toContain('names-only mode — these checks did NOT run')
  })

  it('check-migration-ledger.mjs reads LEGACY_RECONCILED out of the library, not a copy', () => {
    // The audit must suppress the same verified historical exceptions the drift
    // watchdog does, or it reports eleven known-good migrations as missing.
    // It parses them from migration-match.ts rather than restating them; this
    // asserts the parse still finds every entry.
    const script = readFileSync(join(SCRIPTS, 'check-migration-ledger.mjs'), 'utf8')
    expect(script).toContain("readFileSync(join(root, 'lib', 'db', 'migration-match.ts')")

    const src = readFileSync(join(__dirname, 'migration-match.ts'), 'utf8')
    const block = src.match(/LEGACY_RECONCILED[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)
    expect(block, 'the script\'s regex must still match migration-match.ts').toBeTruthy()
    const parsed = new Set([...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
    expect(parsed).toEqual(new Set(LEGACY_RECONCILED))
    expect(parsed.size).toBeGreaterThan(0)
  })

  it('the richer RPC migration exists and is service-role only', () => {
    const sql = readFileSync(
      join(SCRIPTS, '..', 'supabase', 'migrations', '20260902140000_applied_migration_ledger_rpc.sql'),
      'utf8'
    )
    expect(sql).toContain('create or replace function public.applied_migration_ledger()')
    expect(sql).toContain('returns table (version text, name text, created_by text)')
    expect(sql).toContain("set search_path = ''")
    expect(sql).toContain('grant execute on function public.applied_migration_ledger() to service_role')
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toContain(`revoke all on function public.applied_migration_ledger() from ${role}`)
    }
    // read-only: no write verbs anywhere in it
    expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete|truncate)\s/)
  })

  it('apply-migration.mjs offers no way to name a migration by hand', () => {
    const text = readFileSync(join(SCRIPTS, 'apply-migration.mjs'), 'utf8')
    // The invariant is enforced by omission: there must be no --name flag, and
    // the script must actively refuse one.
    expect(text).toContain("arg.startsWith('--name')")
    expect(text).toContain('there is no --name option, on purpose.')
  })
})
