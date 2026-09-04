import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripTsComments } from './db/strip-ts-comments'

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
        // Comments are blanked first: documenting a bad literal must not
        // trip the guard for that literal (2026-08-12).
        const src = stripTsComments(readFileSync(file, 'utf8'))
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

/**
 * Every kind passed to enqueueOutbound must be allowed by
 * caye_outbound_queue_kind_check.
 *
 * WHY THIS EXISTS (2026-08-12)
 * Same bug class as sender_type above, caught the same day. The TS
 * OutboundKind union was extended three separate times without the matching
 * Postgres CHECK constraint ever being updated to match:
 *
 *   'booking_created'      — DB said 'same_day_booking' since the very
 *                             FIRST outbound migration (2026-05-28). Every
 *                             new-booking ping to an operator has silently
 *                             failed to enqueue since the feature existed.
 *   'operator_reminder'    — added in code 2026-08-09, never in the DB.
 *                             Every reminder Caye offered to set has failed.
 *   'dropped_confirmation' — added in code 2026-08-11, caught here before
 *                             it ever fired live.
 *
 * enqueueOutbound swallows the insert error and returns null; nothing
 * downstream checks the return value, so the caller has no idea the ping
 * never went anywhere. This is deliberately NOT scoped like the checks
 * above (`kind: 'literal'` appears constantly for unrelated shapes —
 * metadata.kind, OperatorIntent.kind, coding-session kind) — it's scoped to
 * `enqueueOutbound(` call sites specifically, since that is the one place
 * this exact constraint applies.
 *
 * Update OUTBOUND_KIND_VALUES only when 20260812_fix_outbound_kind_check.sql
 * (or a later migration on the same constraint) changes what's allowed.
 * 'payment_setup_needed' added 2026-08-13
 * (20260813d_add_payment_setup_needed_outbound_kind.sql) — no enqueueOutbound
 * call site uses it yet (see the OutboundKind union's comment in
 * lib/whatsapp/outbound.ts for why), so its absence from any call-site scan
 * is expected; it's listed here purely so this set keeps matching the live
 * constraint per check-constraints.test.ts.
 * 'operator_message' added 2026-08-16 (20260816c_add_operator_message_
 * outbound_kind.sql) for send_operator_message — also no enqueueOutbound
 * call site, by design: that tool inserts the row itself synchronously
 * rather than going through enqueueOutbound (see the OutboundKind union's
 * comment for why), so its absence from the call-site scan is expected too.
 * 'construction_attention' added 2026-09-03 (20260903_add_construction_
 * attention_outbound_kind.sql) for the construction ledger's delivery hop.
 * This one DOES have an enqueueOutbound call site — lib/attention-delivery.ts
 * — so unlike the two above it is expected to appear in the call-site scan.
 */
describe('enqueueOutbound kind matches caye_outbound_queue_kind_check', () => {
  const OUTBOUND_KIND_VALUES = new Set([
    'urgent_hold', 'booking_created', 'auth_failure', 'morning_digest',
    'welcome', 'otp', 'ack', 'escalation', 'escalation_followup',
    'opportunity_scan', 'business_insights', 'operator_reminder',
    'dropped_confirmation', 'reply_review', 'payment_setup_needed',
    'operator_message', 'construction_attention',
  ])

  it('only calls enqueueOutbound with a kind the database accepts', () => {
    const offenders: string[] = []

    for (const file of files) {
      const src = stripTsComments(readFileSync(file, 'utf8'))
      for (const call of src.matchAll(/enqueueOutbound\(/g)) {
        // enqueueOutbound's object argument is small; a 400-char window past
        // the call comfortably covers every real call site in this repo
        // without reaching into an unrelated later call.
        const window = src.slice(call.index, call.index + 400)
        const kindMatch = window.match(/kind:\s*'([^']*)'/)
        if (!kindMatch) continue // kind passed as a variable — type system covers that case
        if (!OUTBOUND_KIND_VALUES.has(kindMatch[1])) {
          const line = src.slice(0, call.index).split('\n').length
          offenders.push(`${file.replace(repoRoot + '/', '')}:${line} → kind: '${kindMatch[1]}'`)
        }
      }
    }

    expect(
      offenders,
      `enqueueOutbound call(s) with a kind the DB constraint rejects. Valid: ` +
        [...OUTBOUND_KIND_VALUES].join(', ') + '\n' + offenders.join('\n')
    ).toEqual([])
  })

  it('rejects the exact mismatch that broke every booking notification since May', () => {
    expect(OUTBOUND_KIND_VALUES.has('same_day_booking')).toBe(false)
    expect(OUTBOUND_KIND_VALUES.has('booking_created')).toBe(true)
  })
})
