/**
 * The migration identity invariant.
 *
 *   repo migration identity == recorded migration identity
 *
 * A migration's identity is its filename, minus `.sql`. That string, and
 * nothing else, is what belongs in supabase_migrations.schema_migrations.name.
 *
 * This file exists because the 2026-09-02 drift incident was not really a
 * schema problem. Migrations here are applied by hand, and whoever applied
 * them typed the ledger name from memory. Fifteen migrations were live and
 * unrecognisable to the watchdog because they had been recorded as
 * hand-written slugs (`lock_perception_runtime_rpcs_to_service_role`), as
 * squashes (four perception migrations under one
 * `perception_hardening_and_direction_bridge` row), or not at all. The
 * watchdog was crying wolf on 15 of 26, which is exactly how the 11 real gaps
 * stayed invisible.
 *
 * Documentation would not have prevented that. Deriving the name mechanically
 * does: see scripts/apply-migration.mjs, which takes a migration FILE and has
 * no parameter for the recorded name, and scripts/check-migration-ledger.mjs,
 * which fails when a ledger row disagrees with the repo.
 *
 * Kept pure and dependency-free so both scripts and the test suite share one
 * definition.
 */

import { MIGRATION_PREFIX, LEGACY_RECONCILED, slugOf } from './migration-match'

/**
 * `created_by` marker identifying rows written by an explicit reconciliation
 * rather than by applying SQL. The date suffix is deliberate: each
 * reconciliation event is separately auditable, and
 * `RECONCILIATION_MARKER_PREFIX` matches all of them.
 *
 * The 2026-09-02 event inserted 15 such rows, each recording that the
 * migration's schema was verified present and that no SQL was re-executed.
 */
export const RECONCILIATION_MARKER_PREFIX = 'migration-drift-reconciliation-'

export function isReconciliationMarker(createdBy: string | null | undefined): boolean {
  return typeof createdBy === 'string' && createdBy.startsWith(RECONCILIATION_MARKER_PREFIX)
}

/**
 * The one true ledger name for a migration file.
 *
 * Accepts a path or a bare filename; rejects anything that is not a migration
 * basename, so a typo cannot quietly become a new alias.
 */
export function ledgerNameForMigrationFile(filePath: string): string {
  const basename = filePath.split('/').pop() ?? ''
  if (!basename.endsWith('.sql')) {
    throw new Error(`not a migration file (expected a .sql basename): ${filePath}`)
  }
  const name = basename.slice(0, -'.sql'.length)
  if (!MIGRATION_PREFIX.test(name)) {
    throw new Error(
      `migration filename does not carry a recognised date prefix: ${basename}\n` +
        `expected <YYYYMMDD[HH[MM[SS]]]><0-2 lowercase letters>_<slug>.sql`
    )
  }
  return name
}

export type LedgerRow = {
  version: string
  name: string | null
  created_by?: string | null
}

export type LedgerFinding =
  | { kind: 'alias'; migration: string; recordedAs: string; detail: string }
  | { kind: 'unknown-row'; recordedAs: string; version: string; detail: string }
  | { kind: 'duplicate-name'; recordedAs: string; versions: string[]; detail: string }

/**
 * Audits ledger rows against the repo, reporting every place the identity
 * invariant is broken.
 *
 * Three findings, in decreasing severity for future trust:
 *
 *  - `alias`         a repo migration whose only ledger row uses some other
 *                    name. This is the class that caused the incident; new
 *                    ones must not appear.
 *  - `unknown-row`   a ledger row naming nothing in the repo. Expected for
 *                    genuinely pre-convention history, which is why rows
 *                    older than `sinceVersion` and rows carrying a
 *                    reconciliation marker are exempt.
 *  - `duplicate-name` the same name recorded twice. Harmless for matching,
 *                    but it means an apply ran twice and is worth seeing.
 *
 * Deliberately NOT a schema check. Proving a migration applied by looking for
 * its objects is how you end up trusting a ledger that disagrees with reality;
 * the invariant is that the ledger is written correctly in the first place.
 */
export function auditLedgerIdentity(options: {
  repoMigrations: readonly string[]
  ledger: readonly LedgerRow[]
  /**
   * Rows with a `version` below this are pre-convention history and are not
   * held to the invariant. Set to the first version applied after the apply
   * tooling landed.
   */
  sinceVersion?: string
}): LedgerFinding[] {
  const { repoMigrations, ledger, sinceVersion } = options
  const findings: LedgerFinding[] = []

  const repo = new Set(repoMigrations)
  const recorded = new Set(ledger.map((r) => r.name).filter((n): n is string => !!n))

  // 1. repo migrations recorded under some other name
  const bySlug = new Map<string, string[]>()
  for (const row of ledger) {
    if (!row.name) continue
    const bucket = bySlug.get(slugOf(row.name))
    if (bucket) bucket.push(row.name)
    else bySlug.set(slugOf(row.name), [row.name])
  }
  // Names already accounted for as some migration's alias, so the same row is
  // not reported twice under two different headings.
  const explainedAliases = new Set<string>()

  for (const migration of repoMigrations) {
    const isLegacy = LEGACY_RECONCILED.has(migration)
    const aliases = bySlug.get(slugOf(migration))?.filter((n) => n !== migration) ?? []
    for (const alias of aliases) explainedAliases.add(alias)
    if (recorded.has(migration)) continue
    if (isLegacy) continue
    if (aliases.length > 0) {
      findings.push({
        kind: 'alias',
        migration,
        recordedAs: aliases[0],
        detail:
          `${migration} is recorded as "${aliases[0]}". Record migrations under ` +
          `their exact filename; use scripts/apply-migration.mjs.`,
      })
    }
  }

  // 2. ledger rows naming nothing in the repo
  for (const row of ledger) {
    if (!row.name) continue
    if (repo.has(row.name)) continue
    if (explainedAliases.has(row.name)) continue
    if (isReconciliationMarker(row.created_by)) continue
    if (sinceVersion && row.version < sinceVersion) continue
    findings.push({
      kind: 'unknown-row',
      recordedAs: row.name,
      version: row.version,
      detail:
        `ledger row ${row.version} is named "${row.name}", which matches no file in ` +
        `supabase/migrations. Either the migration was renamed, or the row was ` +
        `hand-written. Reconciliation rows must carry ` +
        `created_by starting "${RECONCILIATION_MARKER_PREFIX}".`,
    })
  }

  // 3. the same name recorded more than once
  const versionsByName = new Map<string, string[]>()
  for (const row of ledger) {
    if (!row.name) continue
    const bucket = versionsByName.get(row.name)
    if (bucket) bucket.push(row.version)
    else versionsByName.set(row.name, [row.version])
  }
  for (const [name, versions] of versionsByName) {
    if (versions.length < 2) continue
    findings.push({
      kind: 'duplicate-name',
      recordedAs: name,
      versions,
      detail: `"${name}" is recorded ${versions.length} times (${versions.join(', ')}).`,
    })
  }

  return findings
}
