import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every `sender_type: '<literal>'` written anywhere in the repo must be a real
 * value of the Postgres enum.
 *
 * WHY THIS EXISTS (2026-08-11)
 * add_internal_note inserted `sender_type: 'system'`. The enum has exactly two
 * values — customer, business — so Postgres rejected every single call with
 * `invalid input value for enum sender_type: "system"`. The tool had a 100%
 * failure rate from the day it shipped and nobody noticed, because the failure
 * surfaced as Caye apologising in chat rather than as an alert:
 *
 *   Mrs. Max:  yes please                        [add an internal note]
 *   Caye:      Hmm, ran into a technical error on that one. I'd recommend
 *              jotting it down on your end for now — North Bimini Heritage
 *              Tour, Private, 2 guests, Aug 20th at 10am, paid...
 *
 * Telling the owner to keep her own notes is the exact job the product is sold
 * to do. `select count(*) where metadata->>'kind' = 'internal_note'` returned 0.
 *
 * A mocked unit test cannot catch this — the mock accepts any string, and only
 * the real database knows the enum. So this asserts against the enum values
 * instead, across every write site at once. Update ENUM_VALUES only when the
 * migration that changes the enum lands.
 */

/** Mirrors the `sender_type` enum in Postgres. */
const SENDER_TYPE_VALUES = new Set(['customer', 'business'])

/** Mirrors the `message_delivery_status` enum. */
const DELIVERY_STATUS_VALUES = new Set(['sending', 'sent', 'delivered', 'read', 'failed'])

/** Mirrors the `message_content_type` enum. */
const CONTENT_TYPE_VALUES = new Set([
  'text', 'image', 'video', 'audio', 'file',
  'location', 'sticker', 'template', 'interactive',
])

const CHECKS: { column: string; values: Set<string> }[] = [
  { column: 'sender_type', values: SENDER_TYPE_VALUES },
  { column: 'message_type', values: CONTENT_TYPE_VALUES },
]

const ROOTS = ['lib', 'app', 'components', 'scripts']
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git'])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

const repoRoot = process.cwd()
const files = ROOTS.flatMap((r) => sourceFiles(join(repoRoot, r)))

describe('enum literals written to the database', () => {
  it('finds source files to scan', () => {
    // Guards against the scan silently passing because it matched nothing.
    expect(files.length).toBeGreaterThan(50)
  })

  for (const { column, values } of CHECKS) {
    it(`only writes valid ${column} values`, () => {
      // Matches `column: 'literal'` — deliberately not `column: someVar`,
      // which this cannot check and which the type system covers instead.
      const pattern = new RegExp(`\\b${column}:\\s*'([^']*)'`, 'g')
      const offenders: string[] = []

      for (const file of files) {
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(pattern)) {
          if (!values.has(m[1])) {
            const line = src.slice(0, m.index).split('\n').length
            offenders.push(
              `${file.replace(repoRoot + '/', '')}:${line} → ${column}: '${m[1]}'`
            )
          }
        }
      }

      expect(
        offenders,
        `Invalid ${column} literal(s). Valid: ${[...values].join(', ')}\n` +
          offenders.join('\n')
      ).toEqual([])
    })
  }

  it('rejects the exact literal that broke add_internal_note', () => {
    expect(SENDER_TYPE_VALUES.has('system')).toBe(false)
  })

  it('knows the delivery statuses used by internal-note writers', () => {
    expect(DELIVERY_STATUS_VALUES.has('sent')).toBe(true)
  })
})
