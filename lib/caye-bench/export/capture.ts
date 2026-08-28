import 'server-only'
import { randomBytes } from 'node:crypto'
import { captureEpisode } from './queries'
import { buildRawTrace, type BuildRawTraceMeta } from './build-raw-trace'
import { verifySanitizedTrace, type VerifySanitizedResult } from './verify-sanitized'
import { sanitizeRawTrace } from '../replay/sanitize'
import { parseReplayTrace } from '../replay/trace-io'
import type { EpisodeSelector } from './types'
import type { ReplayTrace } from '../replay/types'

/**
 * export/capture.ts — the whole capture pipeline, and the ONLY function
 * outside `queries.ts` that reaches real Supabase (transitively, through
 * `captureEpisode`).
 *
 * `bounded raw query -> buildRawTrace -> sanitizeRawTrace -> verifySanitizedTrace`
 *
 * Fails closed: if `verifySanitizedTrace` finds anything, this throws
 * rather than returning a trace a caller might persist. The salt is
 * freshly random per call (`randomBytes`, never derived from anything
 * durable) and is returned ONLY for the caller's own transient use within
 * the same process — `CaptureResult` never includes it in anything meant
 * to be written to disk, and the CLI (`scripts/caye-bench-export.mjs`)
 * never logs it.
 */
export interface CaptureOptions {
  traceId: string
  meta: BuildRawTraceMeta
}

export interface CaptureResult {
  trace: ReplayTrace
  verification: VerifySanitizedResult
}

export async function captureAndSanitize(selector: EpisodeSelector, opts: CaptureOptions): Promise<CaptureResult> {
  const bundle = await captureEpisode(selector)
  const raw = buildRawTrace(bundle, opts.meta)

  const salt = randomBytes(32).toString('hex')
  const sanitized = sanitizeRawTrace(raw, { traceId: opts.traceId, salt })

  // Re-validate through the same importer a saved fixture would load
  // through — catches a structurally malformed trace before it ever
  // reaches the safety scan below.
  const validated = parseReplayTrace(sanitized)

  const verification = verifySanitizedTrace(validated)
  if (!verification.safe) {
    const summary = verification.issues.map((i) => `  - ${i.path}: ${i.reason} (${i.sample})`).join('\n')
    throw new Error(
      `export/capture: sanitization could not be verified safe — refusing to produce a usable trace.\n${summary}\n` +
        'Fix the underlying data (or extend sanitize.ts\'s redaction) and re-run capture; do not bypass this check.'
    )
  }

  return { trace: validated, verification }
}
