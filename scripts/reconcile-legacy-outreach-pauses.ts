/**
 * One-off: backfill provenance on outreach pauses that predate
 * 20260824_outreach_pause_provenance.sql (issue #162). Finds every
 * workspace with outreach_autosend_paused = true and outreach_pause_source
 * still null, and runs lib/outreach-pause-control.ts's
 * reconcileLegacyOutreachPause against each. That function never clears a
 * pause — it only replays the bounce-threshold rule
 * lib/outreach-kill-switch.ts uses live against the workspace's own bounce
 * log, and backfills outreach_pause_source = 'bounce_safety' (with reason
 * and an audit row) when a real crossing is found. Rows with no crossing
 * evidence are left untouched — that provenance genuinely cannot be
 * established and must keep failing closed.
 *
 * Idempotent and safe to re-run: workspaces already reconciled (or paused
 * for any other known reason) are no-ops.
 *
 * Dry-run by default — reports what it would do without writing. Pass
 * --apply to actually write.
 *
 * Run with (dotenv isn't installed in this repo — source env vars directly):
 *   set -a && source .env.local && set +a && npx tsx scripts/reconcile-legacy-outreach-pauses.ts [--apply]
 */

import { createClient } from '@supabase/supabase-js'

async function main() {
  const apply = process.argv.includes('--apply')

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: rows, error } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id, outreach_bounce_threshold, outreach_bounce_window_hours')
    .eq('outreach_autosend_paused', true)
    .is('outreach_pause_source', null)

  if (error) {
    console.error('Failed to query legacy-paused workspaces:', error.message)
    process.exit(1)
  }

  if (!rows?.length) {
    console.log('No legacy-paused workspaces found (outreach_autosend_paused=true, outreach_pause_source=null). Nothing to reconcile.')
    return
  }

  console.log(`Found ${rows.length} legacy-paused workspace(s).${apply ? '' : ' Dry run — pass --apply to write.'}`)

  // Inline, dependency-free copy of findTrailingWindowCrossing so this
  // script doesn't need 'server-only'-guarded app code — see
  // lib/outreach-pause-control.ts for the source of truth and its tests.
  function findTrailingWindowCrossing(isoTimestamps: string[], threshold: number, windowHours: number): string | null {
    const times = isoTimestamps.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)
    const windowMs = windowHours * 60 * 60 * 1000
    for (let i = 0; i < times.length; i++) {
      const windowStart = times[i] - windowMs
      let count = 0
      for (let j = i; j >= 0 && times[j] > windowStart; j--) count++
      if (count >= threshold) return new Date(times[i]).toISOString()
    }
    return null
  }

  for (const row of rows) {
    const workspaceId = row.workspace_id as string
    const threshold = row.outreach_bounce_threshold ?? 5
    const windowHours = row.outreach_bounce_window_hours ?? 24

    const { data: bounces, error: bounceErr } = await supabase
      .from('caye_outreach_bounces')
      .select('created_at')
      .eq('workspace_id', workspaceId)
    if (bounceErr) {
      console.error(`  ${workspaceId}: failed to read bounce log — ${bounceErr.message}`)
      continue
    }

    const crossing = findTrailingWindowCrossing((bounces ?? []).map((b) => b.created_at as string), threshold, windowHours)
    if (!crossing) {
      console.log(`  ${workspaceId}: no bounce-threshold crossing found (threshold=${threshold}, window=${windowHours}h). Left as unknown — stays fail-closed.`)
      continue
    }

    const reason = `Reconciled from a legacy pause with no recorded provenance: bounce count crossed the safety threshold of ${threshold} within a trailing ${windowHours}h window around ${crossing}. Backfilled retroactively — the original trip predates provenance tracking (20260824_outreach_pause_provenance.sql).`
    console.log(`  ${workspaceId}: crossing found at ${crossing}. ${apply ? 'Writing bounce_safety provenance…' : 'Would write bounce_safety provenance (dry run).'}`)

    if (!apply) continue

    const { data: updated, error: updateErr } = await supabase
      .from('workspace_ai_config')
      .update({ outreach_pause_source: 'bounce_safety', outreach_pause_reason: reason, outreach_paused_at: crossing })
      .eq('workspace_id', workspaceId)
      .eq('outreach_autosend_paused', true)
      .is('outreach_pause_source', null)
      .select('workspace_id')
    if (updateErr) {
      console.error(`    failed to write reconciliation: ${updateErr.message}`)
      continue
    }
    if (!updated?.length) {
      console.log('    skipped — row changed concurrently since it was read (no longer null-source).')
      continue
    }

    const { error: eventErr } = await supabase.from('caye_outreach_pause_events').insert({
      workspace_id: workspaceId, action: 'paused', source: 'bounce_safety', reason, actor_role: 'system',
    })
    if (eventErr) console.error(`    reconciled config but failed to write audit event: ${eventErr.message}`)
    else console.log('    reconciled and audit event recorded.')
  }
}

main()
