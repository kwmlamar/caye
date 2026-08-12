/**
 * check-constraints.ts
 *
 * Reads the allowed values of Postgres CHECK constraints out of the migration
 * files, so a guard can compare code literals against the same source of
 * truth the database was actually built from.
 *
 * WHY THIS EXISTS (2026-08-12)
 * Four instances of one bug class in two days, every one of them a string
 * literal in TypeScript that the database refused:
 *
 *   sender_type: 'system'   — add_internal_note, 100% failure since it shipped
 *   'booking_created'       — DB said 'same_day_booking' since 2026-05-28;
 *                             no operator has ever been pinged about a booking
 *   'operator_reminder'     — added in code 2026-08-09, never in the schema
 *   'dropped_confirmation'  — added in code 2026-08-11, caught pre-launch
 *
 * db-enum-literals.test.ts now guards these, but it guards them by holding a
 * hand-written copy of each constraint's values. That copy is itself a thing
 * that can drift: change a CHECK in a migration, forget the test, and the
 * guard keeps passing against values the database no longer accepts. The
 * guard would be lying, in the same direction as the bug it was built to
 * catch.
 *
 * So the values come from the migrations instead. Adding a value to a CHECK
 * automatically widens what the guard allows; adding a literal in code
 * without the migration still fails. Nothing to remember to update.
 *
 * Kept free of 'server-only' and any Supabase import, like migration-match.ts,
 * so the parsing is directly testable.
 *
 * DELIBERATELY CONSERVATIVE. It reports only constraints it can parse
 * unambiguously and ignores everything else. A parser that guessed would
 * produce spurious failures, and a guard that cries wolf gets ignored —
 * which is precisely how the real gaps stayed invisible for weeks.
 */

/** Allowed values for one `table.column`, as the migrations define it. */
export type ConstraintMap = Map<string, Set<string>>

/** `create table [if not exists] <name> (` — also matches `create table public.x`. */
const CREATE_TABLE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
/** `alter table [only] <name>` */
const ALTER_TABLE = /\balter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
/** `check` keyword; the clause body is then read with a paren counter. */
const CHECK_KEYWORD = /\bcheck\s*\(/gi

/**
 * Read a parenthesised body starting at the open paren, honouring nesting.
 *
 * A regex cannot do this: `check (status in ('a','b'))` has the IN list's
 * closing paren inside the clause, so a non-greedy match stops early and the
 * value list never parses. That mistake silently reduced this parser to three
 * columns out of a dozen — quiet under-reporting, the failure mode a guard can
 * least afford.
 *
 * Quoted strings are skipped so a paren inside a value can't unbalance it.
 */
function readBalanced(sql: string, openIndex: number): { body: string; end: number } | null {
  let depth = 0
  let inQuote = false
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i]
    if (inQuote) {
      // '' is an escaped quote inside a Postgres string literal.
      if (ch === "'") {
        if (sql[i + 1] === "'") i++
        else inQuote = false
      }
      continue
    }
    if (ch === "'") { inQuote = true; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { body: sql.slice(openIndex + 1, i), end: i }
    }
  }
  return null
}

/** `col in ('a', 'b')` — the dominant form. */
const IN_LIST = /\b([a-z_][a-z0-9_]*)\s+in\s*\(([^)]*)\)/i
/** `col = any (array['a'::text, 'b'])` — the form Postgres reports back. */
const ANY_ARRAY = /\b([a-z_][a-z0-9_]*)\s*=\s*any\s*\(\s*array\s*\[([^\]]*)\]/i

/** Quoted values, dropping `::text` and friends. */
function valuesFrom(list: string): string[] {
  const out: string[] = []
  for (const m of list.matchAll(/'([^']*)'/g)) out.push(m[1])
  return out
}

/**
 * Build the constraint map from migration file contents.
 *
 * `files` must be ordered oldest-first — the same filename ordering the
 * migration runner uses. A later definition of the same `table.column`
 * replaces an earlier one, which is what makes drop-and-re-add migrations
 * (the usual way a CHECK gets widened) resolve correctly.
 */
export function parseCheckConstraints(
  files: readonly { name: string; sql: string }[]
): ConstraintMap {
  const map: ConstraintMap = new Map()

  for (const file of files) {
    // Positions of every table-context marker, so a check clause can be
    // attributed to the table it appears under.
    const markers: { index: number; table: string }[] = []
    for (const re of [CREATE_TABLE, ALTER_TABLE]) {
      re.lastIndex = 0
      for (const m of file.sql.matchAll(re)) {
        markers.push({ index: m.index ?? 0, table: m[1].toLowerCase() })
      }
    }
    markers.sort((a, b) => a.index - b.index)
    if (markers.length === 0) continue

    CHECK_KEYWORD.lastIndex = 0
    for (const check of file.sql.matchAll(CHECK_KEYWORD)) {
      const at = check.index ?? 0
      // Nearest preceding create/alter wins.
      let table: string | null = null
      for (const marker of markers) {
        if (marker.index <= at) table = marker.table
        else break
      }
      if (!table) continue

      const clause = readBalanced(file.sql, at + check[0].length - 1)
      if (!clause) continue
      const body = clause.body
      const match = IN_LIST.exec(body) ?? ANY_ARRAY.exec(body)
      if (!match) continue

      const column = match[1].toLowerCase()
      // `col is null or col in (...)` parses to the same column; harmless.
      // Guard against matching a bare keyword as a column name.
      if (column === 'null' || column === 'not' || column === 'or') continue

      const values = valuesFrom(match[2])
      if (values.length === 0) continue

      map.set(`${table}.${column}`, new Set(values))
    }
  }

  return map
}

/** Convenience for tests and callers that only care about one column. */
export function allowedValues(
  map: ConstraintMap,
  table: string,
  column: string
): Set<string> | null {
  return map.get(`${table}.${column}`) ?? null
}
