// One-time backfill: retroactively correct caye_operator_messages rows
// whose stored text fabricates a completed action (a send, a reminder)
// that never actually happened, per the 2026-08-16 stale-claim regression.
//
// Background: action-claim-guard.ts (2026-08-16) checks a reply against
// what actually executed THIS turn before it's ever returned/persisted —
// that closes the hole for every turn generated after the fix shipped.
// It did nothing for rows already sitting in the table from before the fix
// existed. Three hours after deploying it, asked again to message an
// operator, Caye replied "I already sent her that message 3 hours ago" —
// a claim about a send that never happened, traced directly to her own
// sliding-window history still containing the ORIGINAL incident's
// uncorrected row. lib/caye-agent/history-grounding.ts's revalidateHistory
// now runs this same correction at READ time (context.ts's
// loadOperatorContext / loadDirectThreadContext), so the model's context
// can no longer be poisoned by old data going forward. This script is the
// one-time companion: it fixes what's already stored, so a human scrolling
// Caye Direct / Live sees the same corrected text the model now does,
// instead of the original fabrication.
//
// GENERAL, not Mrs.-Max- or workspace-specific: scans every
// (workspace_id, operator_allowlist_id) pair with any caye_operator_messages
// rows and re-validates each one's full history using the exact same
// grouping + reconstruction + enforceActionGrounding logic the live read
// path uses. A row is only ever touched if enforceActionGrounding finds a
// real violation; every other row is left untouched.
//
// Safe to re-run: revalidateHistory is idempotent (correcting an
// already-corrected row is a no-op — see history-grounding.test.ts), and
// this script only issues an UPDATE when the corrected body/claude_format
// actually differs from what's stored. A second run finds nothing left to
// fix.
//
// Dry-run by default. Pass --apply to actually write.
//
// Run with (dotenv isn't installed in this repo — source env vars directly,
// same convention as scripts/source-leads.ts):
//   set -a && source .env.local && set +a && npx tsx scripts/backfill-ungrounded-operator-history.ts
//   set -a && source .env.local && set +a && npx tsx scripts/backfill-ungrounded-operator-history.ts --apply

import { createClient } from '@supabase/supabase-js'
import { revalidateHistory, type StoredTurnRow } from '../lib/caye-agent/history-grounding'

interface Row extends StoredTurnRow {
  id: string
  workspace_id: string
  operator_allowlist_id: number | null
}

async function main() {
  const apply = process.argv.includes('--apply')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: pairs, error: pairsError } = await supabase
    .from('caye_operator_messages')
    .select('workspace_id, operator_allowlist_id')
  if (pairsError) {
    console.error('failed to list workspace/operator pairs:', pairsError.message)
    process.exitCode = 1
    return
  }

  const seen = new Set<string>()
  const uniquePairs: Array<{ workspace_id: string; operator_allowlist_id: number | null }> = []
  for (const p of pairs ?? []) {
    const key = `${p.workspace_id}:${p.operator_allowlist_id ?? 'null'}`
    if (seen.has(key)) continue
    seen.add(key)
    uniquePairs.push(p)
  }

  console.log(`scanning ${uniquePairs.length} (workspace, operator) pairs...`)

  let rowsScanned = 0
  let rowsCorrected = 0

  for (const pair of uniquePairs) {
    let query = supabase
      .from('caye_operator_messages')
      .select('id, workspace_id, operator_allowlist_id, direction, body, claude_format, created_at')
      .eq('workspace_id', pair.workspace_id)
      .order('created_at', { ascending: true })

    query = pair.operator_allowlist_id != null
      ? query.eq('operator_allowlist_id', pair.operator_allowlist_id)
      : query.is('operator_allowlist_id', null)

    const { data, error } = await query
    if (error) {
      console.error(`skip ${pair.workspace_id}/${pair.operator_allowlist_id}: ${error.message}`)
      continue
    }

    const rows = (data ?? []) as Row[]
    rowsScanned += rows.length
    const corrected = revalidateHistory(rows) as Row[]

    for (let i = 0; i < rows.length; i++) {
      const original = rows[i]
      const fixed = corrected[i]
      if (fixed.body === original.body) continue // untouched by revalidateHistory

      rowsCorrected++
      console.log(
        `[${apply ? 'APPLY' : 'DRY RUN'}] ${original.id} (ws=${original.workspace_id} op=${original.operator_allowlist_id})\n` +
          `  before: ${original.body.slice(0, 160)}\n` +
          `  after:  ${fixed.body.slice(0, 160)}`
      )
      if (apply) {
        const { error: updateError } = await supabase
          .from('caye_operator_messages')
          .update({ body: fixed.body, claude_format: fixed.claude_format })
          .eq('id', original.id)
        if (updateError) console.error(`  UPDATE FAILED: ${updateError.message}`)
      }
    }
  }

  console.log(`\nscanned ${rowsScanned} rows, ${rowsCorrected} needed correction.`)
  if (!apply && rowsCorrected > 0) {
    console.log('dry run only — re-run with --apply to write these corrections.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
