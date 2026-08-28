import { readFileSync } from 'node:fs'
import { REPLAY_TRACE_SCHEMA_VERSION, type ReplayTrace } from './types'

/**
 * replay/trace-io.ts — the safe importer.
 *
 * `parseReplayTrace` is the ONLY way a `ReplayTrace` should enter the
 * system from a file (or, eventually, an object store) — it rejects
 * anything that isn't shaped like the versioned schema, so a malformed
 * or wrong-version fixture fails loudly at load time instead of quietly
 * producing a meaningless replay run. This is a structural validator
 * (required fields present, correct top-level types, self-consistent
 * actor/event references), not a full JSON-schema — sufficient to catch
 * "this isn't a replay trace" and "this trace references an actor that
 * doesn't exist," which is what a hand-authored or hand-edited fixture
 * actually gets wrong.
 */

const REQUIRED_KEYS = [
  'schemaVersion',
  'traceId',
  'workspaceId',
  'sourceDescription',
  'sanitizedAt',
  'startTime',
  'timezone',
  'businessName',
  'actors',
  'events',
  'seed',
  'historicalEffects',
  'provenance',
] as const

export function parseReplayTrace(value: unknown): ReplayTrace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid replay trace: expected a JSON object')
  }
  const v = value as Record<string, unknown>

  for (const key of REQUIRED_KEYS) {
    if (!(key in v)) throw new Error(`invalid replay trace: missing required field "${key}"`)
  }
  if (v.schemaVersion !== REPLAY_TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported replay trace schemaVersion: ${JSON.stringify(v.schemaVersion)} (this build supports ${REPLAY_TRACE_SCHEMA_VERSION})`)
  }
  if (!Array.isArray(v.actors) || v.actors.length === 0) {
    throw new Error('invalid replay trace: "actors" must be a non-empty array')
  }
  if (!Array.isArray(v.events) || v.events.length === 0) {
    throw new Error('invalid replay trace: "events" must be a non-empty array')
  }
  if (!Array.isArray(v.historicalEffects)) {
    throw new Error('invalid replay trace: "historicalEffects" must be an array (use [] if genuinely none)')
  }

  const actorIds = new Set((v.actors as Array<{ id?: unknown }>).map((a) => a.id))
  for (const event of v.events as Array<{ id?: unknown; actor?: { id?: unknown } }>) {
    if (!event.actor || !actorIds.has(event.actor.id)) {
      throw new Error(`invalid replay trace: event "${String(event.id)}" references an actor not present in "actors"`)
    }
  }

  const eventIds = new Set<string>()
  for (const event of v.events as Array<{ id?: unknown }>) {
    const id = String(event.id)
    if (eventIds.has(id)) throw new Error(`invalid replay trace: duplicate event id "${id}"`)
    eventIds.add(id)
  }

  return v as unknown as ReplayTrace
}

export function loadReplayTraceFile(path: string): ReplayTrace {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`could not read replay trace file "${path}": ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`replay trace file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseReplayTrace(parsed)
}
