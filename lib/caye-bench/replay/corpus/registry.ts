import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReplayTrace } from '../trace-io'
import {
  jeffDworkinDraftFailureTrace,
  jeffDworkinDraftFailureTurnScripts,
  mrsMaxCorrectionReuseTrace,
  mrsMaxCorrectionReuseTurnScripts,
  autumnMcneillRedundantNotificationTrace,
  autumnMcneillRedundantNotificationTurnScripts,
} from '../fixtures'
import type { CorpusEntry } from './types'

/**
 * corpus/registry.ts — the local replay corpus.
 *
 * Seeded with the three sanitized historical fixtures from #168. This PR
 * does not add fabricated "production" traces — no real Supabase access
 * was available/attempted in this environment (see
 * `lib/caye-bench/export/`'s header comment for the exporter that WOULD
 * produce real ones, and the PR description for why none are included
 * here). `fixtures/production/*.json` is where `npm run caye:bench:export
 * -- --save` writes sanitized traces captured from real operational
 * history — auto-discovered below, so adding one there is enough to grow
 * the corpus without touching this file.
 */

const HAND_AUTHORED_ENTRIES: CorpusEntry[] = [
  {
    traceId: jeffDworkinDraftFailureTrace.traceId,
    trace: jeffDworkinDraftFailureTrace,
    categories: ['conversation', 'consequential-action', 'ambiguous-failure'],
    addedAt: '2026-08-27',
    turnScripts: jeffDworkinDraftFailureTurnScripts,
  },
  {
    traceId: mrsMaxCorrectionReuseTrace.traceId,
    trace: mrsMaxCorrectionReuseTrace,
    categories: ['conversation', 'correction', 'cross-channel'],
    addedAt: '2026-08-27',
    turnScripts: mrsMaxCorrectionReuseTurnScripts,
  },
  {
    traceId: autumnMcneillRedundantNotificationTrace.traceId,
    trace: autumnMcneillRedundantNotificationTrace,
    categories: ['conversation', 'proactive-notification'],
    addedAt: '2026-08-27',
    turnScripts: autumnMcneillRedundantNotificationTurnScripts,
  },
]

/**
 * `fixtures/production/*.json` — sanitized traces saved via
 * `npm run caye:bench:export -- --save`. Each file is a JSON object with
 * two top-level keys: `trace` (a `ReplayTrace`, validated through
 * `parseReplayTrace` before anything trusts it) and `entry` (the
 * `CorpusEntry` metadata minus `trace`/`traceId`, which are derived).
 * Missing/empty directory is normal or expected in this PR, not an error.
 */
function loadProductionEntries(): CorpusEntry[] {
  const dir = join(__dirname, '..', 'fixtures', 'production')
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  return files.map((file) => {
    const path = join(dir, file)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`corpus/registry: "${file}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const record = parsed as Record<string, unknown>
    if (!record || typeof record !== 'object' || !('trace' in record) || !('entry' in record)) {
      throw new Error(`corpus/registry: "${file}" must be { trace: ReplayTrace, entry: CorpusEntryMeta }`)
    }
    const trace = parseReplayTrace(record.trace)
    const entryMeta = record.entry as Omit<CorpusEntry, 'trace' | 'traceId'>
    return { ...entryMeta, traceId: trace.traceId, trace }
  })
}

export const CORPUS: CorpusEntry[] = [...HAND_AUTHORED_ENTRIES, ...loadProductionEntries()]

export function validateCorpus(entries: CorpusEntry[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.traceId !== entry.trace.traceId) {
      throw new Error(`corpus/registry: entry.traceId "${entry.traceId}" does not match trace.traceId "${entry.trace.traceId}"`)
    }
    if (seen.has(entry.traceId)) {
      throw new Error(`corpus/registry: duplicate traceId "${entry.traceId}" in corpus`)
    }
    seen.add(entry.traceId)
    const status = entry.status ?? 'active'
    if (status !== 'active' && status !== 'pending_replay_fixture') {
      throw new Error(`corpus/registry: entry "${entry.traceId}" has unknown status "${status}"`)
    }
    for (const defect of entry.knownReplayDefects ?? []) {
      if (!defect.invariant || !defect.detailContains || !defect.note) {
        throw new Error(
          `corpus/registry: entry "${entry.traceId}" declares a knownReplayDefects entry missing invariant/detailContains/note — bare invariant-only allowlisting is exactly the over-broad suppression this shape replaced.`
        )
      }
    }
  }
}

validateCorpus(CORPUS)
