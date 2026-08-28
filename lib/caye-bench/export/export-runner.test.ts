import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * export/export-runner.test.ts
 *
 * Step 1 of the capture workflow ("preview") — the ONLY test file in this
 * repo that does NOT mock `@/lib/supabase-server`. It requires real
 * `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars to do
 * anything (`createServiceClient` throws otherwise, same as any
 * production route). This is the explicit "production access exists only
 * in an explicit export/capture boundary" the task requires — this file
 * IS that boundary, and it is the only one.
 *
 * `describe.skipIf(!LIVE)`-gated so a bare `npm test` never attempts a
 * real connection: `CAYE_BENCH_EXPORT_LIVE=1` is set ONLY by
 * `scripts/caye-bench-export.mjs`'s `preview` subcommand, never by CI.
 *
 * Writes the SANITIZED result (already passed through
 * `verifySanitizedTrace`) to `.caye-bench-export-tmp/` — gitignored, and
 * a distinct directory from anywhere `git add` would ever look. Nothing
 * raw ever touches disk: `capture.ts`'s pipeline sanitizes in memory
 * before this file writes anything.
 */
const LIVE = process.env.CAYE_BENCH_EXPORT_LIVE === '1'

describe.skipIf(!LIVE)('Caye Bench v2.5 — production export capture (manual/CLI only, never part of the default test run)', () => {
  it('captures, sanitizes, and verifies one bounded episode from real production data', async () => {
    const { captureAndSanitize } = await import('./capture')
    const selectorJson = process.env.CAYE_BENCH_EXPORT_SELECTOR
    const traceId = process.env.CAYE_BENCH_EXPORT_TRACE_ID
    const sourceDescription = process.env.CAYE_BENCH_EXPORT_DESCRIPTION
    if (!selectorJson) throw new Error('CAYE_BENCH_EXPORT_LIVE=1 requires CAYE_BENCH_EXPORT_SELECTOR (JSON-encoded EpisodeSelector).')
    if (!traceId) throw new Error('CAYE_BENCH_EXPORT_LIVE=1 requires CAYE_BENCH_EXPORT_TRACE_ID.')
    if (!sourceDescription) {
      throw new Error(
        'CAYE_BENCH_EXPORT_LIVE=1 requires CAYE_BENCH_EXPORT_DESCRIPTION — a non-identifying summary of the FAILURE MODE ' +
          '("draft-in-inbox timeout during a payment exchange"), never a specific person\'s story. See sanitize.ts\'s header comment.'
      )
    }

    const selector = JSON.parse(selectorJson)
    const { trace, verification } = await captureAndSanitize(selector, {
      traceId,
      meta: { sourceDescription, exportedBy: process.env.USER ?? process.env.CAYE_BENCH_EXPORT_AUTHOR ?? undefined },
    })

    const outDir = join(process.cwd(), '.caye-bench-export-tmp')
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${traceId}.preview.json`)
    writeFileSync(outPath, JSON.stringify(trace, null, 2))

    // eslint-disable-next-line no-console
    console.log(`\n[export] wrote sanitized PREVIEW to ${outPath}`)
    // eslint-disable-next-line no-console
    console.log('[export] REVIEW THIS FILE before running the save step. It already passed verifySanitizedTrace — that is')
    // eslint-disable-next-line no-console
    console.log('[export] defense in depth, not proof of anonymity. Read it like a human, not just a regex.')
    // eslint-disable-next-line no-console
    console.log(`[export] verification: safe=${verification.safe}, actors=${trace.actors.length}, events=${trace.events.length}`)

    expect(verification.safe).toBe(true)
    expect(trace.traceId).toBe(traceId)
  }, 60_000)
})
