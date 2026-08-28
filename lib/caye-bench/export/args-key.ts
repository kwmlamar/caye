import { createHash } from 'node:crypto'
import { stableArgsKey } from '../../caye-agent/tools/high-risk-gate'

/**
 * export/args-key.ts — the exporter's args-key correlation primitive.
 *
 * `stableArgsKey` (`lib/caye-agent/tools/high-risk-gate.ts`, unmodified)
 * is the EXACT function production's own high-risk gate uses to find the
 * specific `caye_pending_actions` row a resubmitted high-risk call
 * confirms (`.eq('args_key', argsKey)`, scoped to workspace_id + tool_name
 * + operator_id — see `high-risk-gate.ts`'s resubmission-match query).
 * Reusing it here — rather than a weaker, exporter-invented match like
 * bare `tool_name` — is what lets `build-raw-trace.ts` tell apart two
 * different customers' concurrent calls to the same high-risk tool: their
 * `args` differ, so their `stableArgsKey` differs, so they never collide.
 *
 * `stableArgsKey` itself returns raw, sorted JSON of the args — the exact
 * same sensitivity as `args`, since it's a key-sorted stringify, not a
 * digest. Both helpers below hash it immediately with sha256 so nothing
 * downstream in this exporter ever holds or compares raw args content
 * beyond this one step — matching `caye_tool_calls.args`'s own treatment
 * (already fetched, already in memory for THIS episode, but never copied
 * into a `RawTraceInput`/`ReplayTrace`), and specifically preventing a
 * `caye_pending_actions` row belonging to an unrelated concurrent
 * customer (pulled in only for correlation, not otherwise part of this
 * episode) from ever surfacing its raw args content anywhere in the
 * exporter's output.
 */

/** Hashes a tool call's own `args` object — the same shape passed to
 *  `stableArgsKey` by the real gate. Returns `null` when `args` is
 *  `undefined` (stableArgsKey/JSON.stringify cannot represent that
 *  deterministically) — callers must treat `null` as "cannot prove a
 *  unique match," never as a wildcard. */
export function hashArgsObject(args: unknown): string | null {
  if (args === undefined) return null
  try {
    return createHash('sha256').update(stableArgsKey(args)).digest('hex')
  } catch {
    return null
  }
}

/** Hashes an ALREADY-COMPUTED `caye_pending_actions.args_key` string
 *  (production wrote this with `stableArgsKey` itself, so hashing it
 *  directly — no re-running `stableArgsKey` on it — produces the exact
 *  same digest `hashArgsObject` would for the equivalent args object). */
export function hashArgsKeyString(argsKey: string): string {
  return createHash('sha256').update(argsKey).digest('hex')
}
