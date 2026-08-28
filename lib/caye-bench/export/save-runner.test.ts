import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * export/save-runner.test.ts
 *
 * Step 2 of the capture workflow ("save") — reads an ALREADY-SANITIZED
 * preview file (step 1's output, human-reviewed in between), re-verifies
 * it (defense in depth — never trust that a file on disk hasn't been
 * hand-edited since preview), and writes it into the tracked
 * `replay/fixtures/production/` directory. This is the ONLY step that
 * writes to a git-tracked path — deliberately separated from `preview`
 * (export-runner.test.ts) so raw/unreviewed production information can
 * never land in a commit by a single command.
 *
 * Needs no Supabase access at all (reads a local file), but is still
 * `skipIf`-gated on its own env var for the same reason every other
 * manual-only Caye Bench entry point is: a bare `npm test` should never
 * try to write a new fixture file from stale env vars left over in a
 * shell.
 */
const SAVE = process.env.CAYE_BENCH_EXPORT_SAVE === '1'

describe.skipIf(!SAVE)('Caye Bench v2.5 — save a reviewed export preview as a tracked corpus fixture', () => {
  it('re-verifies the preview and writes { trace, entry } into fixtures/production/', async () => {
    const { parseReplayTrace } = await import('../replay/trace-io')
    const { verifySanitizedTrace } = await import('./verify-sanitized')

    const fromPath = process.env.CAYE_BENCH_EXPORT_FROM
    const name = process.env.CAYE_BENCH_EXPORT_SAVE_NAME
    if (!fromPath) throw new Error('CAYE_BENCH_EXPORT_SAVE=1 requires CAYE_BENCH_EXPORT_FROM (path to a preview file from the preview step).')
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('CAYE_BENCH_EXPORT_SAVE=1 requires CAYE_BENCH_EXPORT_SAVE_NAME (lowercase, hyphenated).')
    if (!existsSync(fromPath)) throw new Error(`preview file not found: ${fromPath}`)

    const parsed = parseReplayTrace(JSON.parse(readFileSync(fromPath, 'utf8')))
    const verification = verifySanitizedTrace(parsed)
    if (!verification.safe) {
      throw new Error(
        `export/save: preview file failed re-verification — refusing to save.\n` +
          verification.issues.map((i) => `  - ${i.path}: ${i.reason} (${i.sample})`).join('\n')
      )
    }

    const categories = (process.env.CAYE_BENCH_EXPORT_CATEGORIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (categories.length === 0) throw new Error('CAYE_BENCH_EXPORT_SAVE=1 requires CAYE_BENCH_EXPORT_CATEGORIES (comma-separated).')
    const incidentRefs = (process.env.CAYE_BENCH_EXPORT_INCIDENT_REFS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const knownDefectNote = process.env.CAYE_BENCH_EXPORT_KNOWN_DEFECT_NOTE
    const knownReplayDefects = (process.env.CAYE_BENCH_EXPORT_KNOWN_DEFECTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (knownReplayDefects.length > 0 && !knownDefectNote) {
      throw new Error('CAYE_BENCH_EXPORT_KNOWN_DEFECTS was set without CAYE_BENCH_EXPORT_KNOWN_DEFECT_NOTE explaining it.')
    }

    const entry = {
      categories,
      incidentRefs: incidentRefs.length > 0 ? incidentRefs : undefined,
      addedAt: new Date().toISOString().slice(0, 10),
      ...(knownReplayDefects.length > 0 ? { knownReplayDefects, knownDefectNote } : {}),
    }

    const outDir = join(__dirname, '..', 'replay', 'fixtures', 'production')
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${name}.json`)
    if (existsSync(outPath)) {
      throw new Error(`${outPath} already exists — choose a different --name or remove the existing fixture first.`)
    }
    writeFileSync(outPath, JSON.stringify({ trace: parsed, entry }, null, 2))

    // eslint-disable-next-line no-console
    console.log(`\n[export] saved fixture: ${outPath}`)
    // eslint-disable-next-line no-console
    console.log('[export] next: git add it, run `npm run caye:bench:corpus` to confirm it passes, then commit.')
    // eslint-disable-next-line no-console
    console.log('[export] NOTE: this trace has no bundled turnScripts yet — the corpus runner needs one added to')
    console.log('[export] lib/caye-bench/replay/corpus/registry.ts (or embedded in the fixture) before it can run offline;')
    // eslint-disable-next-line no-console
    console.log('[export] until then, run it with --live or exclude it from the default corpus run.')

    expect(existsSync(outPath)).toBe(true)
  })
})
