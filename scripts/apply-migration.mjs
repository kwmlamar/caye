#!/usr/bin/env node
/**
 * Builds the exact, complete statement for applying one migration — body plus
 * its ledger row — so that nobody types a migration name by hand.
 *
 * Why this exists
 * ---------------
 * Caye's migrations are applied by hand against the hosted database. Whoever
 * applied them also typed the `name` recorded in
 * supabase_migrations.schema_migrations, from memory. By 2026-09-02 that had
 * produced: four migrations squashed under one invented name, several recorded
 * as hand-written slugs, one applied with no ledger row at all, and fifteen
 * live migrations the drift watchdog could not recognise. The watchdog was
 * wrong on 15 of the 26 it flagged, which is exactly how the 11 real gaps
 * stayed invisible for days.
 *
 * The name is not a judgement call. It is the filename. This script derives it
 * and emits one transaction, so the hand-typed step disappears:
 *
 *     node scripts/apply-migration.mjs supabase/migrations/20260902120000_foo.sql
 *
 * Paste the output into the Supabase SQL editor (or pipe it to psql). The
 * migration and its ledger row commit together or not at all — a migration can
 * no longer be applied without being recorded, which was its own failure mode.
 *
 * Atomicity, in both directions
 * -----------------------------
 * The ledger insert carries NO conflict clause. That is deliberate and it is
 * the whole guarantee:
 *
 *     migration SQL commits  <=>  its exact ledger row commits
 *
 * An earlier revision swallowed a primary-key conflict on `version`, which
 * broke the invariant in the one direction that matters: had the generated
 * version collided with an existing row, the insert would have been skipped
 * silently, the transaction would have committed, and the schema would have
 * changed with no ledger row — recreating the exact incident class this script
 * exists to prevent. A plain insert makes Postgres raise 23505 instead, which
 * aborts the whole transaction and rolls the migration back with it.
 *
 * This is not an upsert. It never overwrites another ledger row, and it never
 * invents a second identity to dodge a collision. It fails closed.
 *
 * This script deliberately does NOT connect to a database. It has no
 * credentials, no --name flag, and no way to record a migration under any name
 * other than its filename. Refusing to offer the unsafe option is the point.
 *
 * Verify afterwards with:
 *     node scripts/check-migration-ledger.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const MIGRATION_PREFIX = /^\d{8}(?:\d{2}|\d{4}|\d{6})?[a-z]{0,2}_/

function fail(message) {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

const [, , ...args] = process.argv

for (const arg of args) {
  if (arg.startsWith('--name')) {
    fail(
      'there is no --name option, on purpose.\n' +
        '    A migration is recorded under its filename or not at all. If the name\n' +
        '    looks wrong, rename the file and commit that.'
    )
  }
}

const target = args.find((a) => !a.startsWith('-'))
if (!target) {
  fail('usage: node scripts/apply-migration.mjs supabase/migrations/<file>.sql')
}

const path = resolve(target)
if (!existsSync(path)) fail(`no such file: ${target}`)

const file = basename(path)
if (!file.endsWith('.sql')) fail(`not a .sql migration: ${file}`)

const name = file.slice(0, -'.sql'.length)
if (!MIGRATION_PREFIX.test(name)) {
  fail(
    `filename carries no recognised migration prefix: ${file}\n` +
      '    expected <YYYYMMDD[HH[MM[SS]]]><0-2 lowercase letters>_<slug>.sql\n' +
      '    A file the drift watchdog cannot parse is a file it cannot police.'
  )
}

const body = readFileSync(path, 'utf8').trimEnd()
if (!body) fail(`${file} is empty`)

// A `commit;` inside the body would close the wrapper transaction early and let
// the migration commit before the ledger insert ran — the same schema-without-a-
// row outcome, by a different route. No migration in the repo does this today;
// refuse rather than let the first one through silently. (Function bodies and
// `case … end;` are stripped first so they do not false-positive.)
const scanned = body
  .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '')
  .replace(/--[^\n]*/g, '')
if (/^\s*(begin|commit|rollback|start\s+transaction)\s*;/im.test(scanned)) {
  fail(
    `${file} contains its own transaction control.\n` +
      '    This script wraps the migration and its ledger row in one transaction;\n' +
      '    a begin/commit inside the body would break that and could commit the\n' +
      '    schema change without its ledger row. Remove it, or apply and record\n' +
      '    this migration deliberately by hand.'
  )
}

// 14-digit UTC YYYYMMDDHHMMSS — the Supabase CLI's own format, which every row
// already in this ledger uses. Keeping it means `supabase migration list` and
// anything else reading the ledger keeps working, and rows keep sorting in
// apply order.
//
// Second precision means two applies inside the same second collide. That is
// reachable in practice — a scripted rollout loop applying several migrations
// back to back — so it is handled rather than assumed away: the collision
// raises 23505 and rolls the whole transaction back. Nothing is applied,
// nothing is recorded, and re-running this generator a second later produces a
// fresh version. A noisy abort is the correct outcome; a silent skip was the bug.
//
// Ledger `version` is only a primary key. `name` is the identity the drift
// watchdog matches on, and that comes from the filename.
const now = new Date()
const version = [
  now.getUTCFullYear(),
  String(now.getUTCMonth() + 1).padStart(2, '0'),
  String(now.getUTCDate()).padStart(2, '0'),
  String(now.getUTCHours()).padStart(2, '0'),
  String(now.getUTCMinutes()).padStart(2, '0'),
  String(now.getUTCSeconds()).padStart(2, '0'),
].join('')

const quoted = (s) => `'${String(s).replace(/'/g, "''")}'`

process.stdout.write(`-- ─────────────────────────────────────────────────────────────────────────
-- ${file}
-- generated by scripts/apply-migration.mjs — do not edit the ledger name below
-- ─────────────────────────────────────────────────────────────────────────
begin;

${body}

-- Recorded under the filename, derived mechanically. Committing this in the
-- same transaction as the migration is what keeps repo identity and ledger
-- identity from drifting apart.
--
-- No conflict clause, deliberately. If this version already exists Postgres
-- raises 23505 and the whole transaction rolls back, taking the migration above
-- with it. Swallowing that conflict would commit the schema change with no
-- ledger row, which is the failure this script exists to prevent.
insert into supabase_migrations.schema_migrations (version, name, statements)
values (
  ${quoted(version)},
  ${quoted(name)},
  array[${quoted(`-- applied from supabase/migrations/${file}`)}]
);

commit;
`)

process.stderr.write(
  `\n  migration : ${file}\n` +
    `  ledger name: ${name}\n` +
    `  version    : ${version}\n\n` +
    `  Review the SQL above, run it as one transaction, then verify:\n` +
    `      node scripts/check-migration-ledger.mjs\n\n` +
    `  If it aborts with 23505 on schema_migrations, version ${version} is\n` +
    `  already taken. Nothing was applied and nothing was recorded — re-run\n` +
    `  this command for a fresh version. Do not edit the insert to get past it.\n\n`
)
