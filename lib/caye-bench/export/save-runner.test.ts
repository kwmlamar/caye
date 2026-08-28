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
    const knownReplayDefectsRaw = (process.env.CAYE_BENCH_EXPORT_KNOWN_DEFECTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (knownReplayDefectsRaw.length > 0 && !knownDefectNote) {
      throw new Error('CAYE_BENCH_EXPORT_KNOWN_DEFECTS was set without CAYE_BENCH_EXPORT_KNOWN_DEFECT_NOTE explaining it.')
    }
    // Each entry is "invariant::detail-substring", not a bare invariant id
    // — a bare invariant would suppress EVERY future violation of that
    // category on this trace, forever, which is exactly what the
    // narrowly-scoped ExpectedDefect shape (corpus/types.ts) exists to
    // prevent. detailContains must match a substring of the violation's
    // `detail` text (see BenchInvariantGate.evaluate in gate.ts for what
    // that text looks like per invariant).
    const knownReplayDefects = knownReplayDefectsRaw.map((raw) => {
      const [invariant, detailContains] = raw.split('::')
      if (!invariant || !detailContains) {
        throw new Error(
          `CAYE_BENCH_EXPORT_KNOWN_DEFECTS entry "${raw}" must be "invariant::detail-substring" ` +
            `(e.g. "fabricated_action_or_result::draft_in_inbox") — a bare invariant id would suppress every future violation of that category.`
        )
      }
      return { invariant, detailContains, note: knownDefectNote as string }
    })

    const entry = {
      categories,
      incidentRefs: incidentRefs.length > 0 ? incidentRefs : undefined,
      addedAt: new Date().toISOString().slice(0, 10),
      // Freshly captured production fixtures start 'pending_replay_fixture'
      // — deliberately NOT counted as corpus coverage until a human adds
      // turnScripts and flips this to 'active' in registry.ts (or the
      // fixture JSON). See corpus/types.ts's CorpusEntryStatus for why
      // this default matters: an unwired fixture must never silently
      // "protect" anything.
      status: 'pending_replay_fixture' as const,
      ...(knownReplayDefects.length > 0 ? { knownReplayDefects } : {}),
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
    console.log('[export] status: pending_replay_fixture — NOT yet counted as corpus coverage or protecting anything.')
    // eslint-disable-next-line no-console
    console.log('[export] next: add turnScripts for this trace (embed in the fixture JSON, or in registry.ts) and set')
    // eslint-disable-next-line no-console
    console.log('[export] entry.status to "active", then run `npm run caye:bench:corpus` to confirm it passes before committing.')
    // eslint-disable-next-line no-console
    console.log('[export] an "active" entry with no turnScripts fails the corpus run as a coverage gap — by design.')

    expect(existsSync(outPath)).toBe(true)
  })
})
