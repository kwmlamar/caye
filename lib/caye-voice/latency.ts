import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Stage-level latency tracing for one voice turn.
 *
 * Why AsyncLocalStorage rather than threading a tracer argument through
 * runFounderThreadTurn -> runCayeDirectRouterTurn -> runFounderToolLoop:
 * those are shared code paths that also serve WhatsApp, cron briefings and
 * the typed Direct composer. Adding a required parameter to all of them to
 * satisfy one surface's observability would be a worse trade than an
 * ambient store that is a hard no-op whenever no voice turn is in flight —
 * `mark()` outside a trace does nothing and allocates nothing.
 *
 * Deliberately console-only, mirroring observability.ts's reasoning: the
 * numbers this produces are for a live latency investigation, not a
 * product feature, and a schema migration for them is more commitment than
 * the data has earned. Grep Vercel logs for `[caye-voice] turn_timeline`.
 *
 * NEVER records transcript text, reply text, tool arguments or tool
 * results — only stage names, durations and coarse sizes. Same rule as
 * logVoiceEvent.
 */

export type VoiceStage =
  // server, request lifecycle
  | 'request_received'
  | 'auth_ok'
  | 'fast_path_hit'
  | 'fast_path_miss'
  | 'turn_start'
  // server, reasoning
  | 'context_build_start'
  | 'context_build_done'
  | 'model_round_start'
  | 'model_round_done'
  | 'tool_start'
  | 'tool_done'
  | 'reasoning_done'
  // server, persistence
  | 'persist_start'
  | 'persist_done'
  | 'response_sent'

export interface VoiceMark {
  stage: VoiceStage
  /** ms since the trace started. */
  atMs: number
  /** Coarse, non-sensitive detail: tool name, backend id, token counts. */
  detail?: Record<string, string | number | boolean>
}

interface VoiceTrace {
  workspaceId: string
  sessionId: string
  startedAt: number
  marks: VoiceMark[]
}

const store = new AsyncLocalStorage<VoiceTrace>()

/**
 * Record a stage boundary on the current voice turn, if one is in flight.
 * Safe to call from shared code that usually has no voice turn above it —
 * that is the normal case and costs one AsyncLocalStorage read.
 */
export function mark(stage: VoiceStage, detail?: VoiceMark['detail']): void {
  const trace = store.getStore()
  if (!trace) return
  trace.marks.push({ stage, atMs: Math.round(performance.now() - trace.startedAt), detail })
}

/**
 * Derived metrics the latency investigation actually reasons about, all
 * measured server-side. The client contributes the speech/playback halves
 * separately (see lib/caye-voice/client/voice-timeline.ts) — this half
 * covers "request arrived" through "response sent".
 */
export interface VoiceTurnTimings {
  /** requireFounder() round trip. */
  authMs: number | null
  /** buildBackOfficeTurnContext: the serial DB chain before any model call. */
  contextBuildMs: number | null
  /** Wall time inside the model/tool loop, first round start to reasoning done. */
  reasoningMs: number | null
  /** Summed tool execution wall time. */
  toolMs: number | null
  howManyTools: number
  /** Persistence after Caye already knew the reply — pure post-answer cost. */
  persistMs: number | null
  /** Whole request. */
  totalMs: number
}

export function computeTimings(marks: readonly VoiceMark[], totalMs: number): VoiceTurnTimings {
  const at = (stage: VoiceStage): number | null => marks.find((m) => m.stage === stage)?.atMs ?? null
  const span = (from: VoiceStage, to: VoiceStage): number | null => {
    const a = at(from)
    const b = at(to)
    return a == null || b == null ? null : b - a
  }

  // Tools can run several times per turn; pair them in order rather than
  // assuming one.
  let toolMs: number | null = null
  let howManyTools = 0
  const starts = marks.filter((m) => m.stage === 'tool_start')
  const dones = marks.filter((m) => m.stage === 'tool_done')
  const paired = Math.min(starts.length, dones.length)
  if (paired > 0) {
    toolMs = 0
    for (let i = 0; i < paired; i++) toolMs += dones[i].atMs - starts[i].atMs
    howManyTools = paired
  }

  return {
    authMs: span('request_received', 'auth_ok'),
    contextBuildMs: span('context_build_start', 'context_build_done'),
    reasoningMs: span('model_round_start', 'reasoning_done'),
    toolMs,
    howManyTools,
    persistMs: span('persist_start', 'persist_done'),
    totalMs,
  }
}

/**
 * Run one voice turn inside a trace and emit a single structured timeline
 * line when it settles — on the error path too, since a slow failure is
 * exactly the case worth measuring.
 */
export async function withVoiceTurnTrace<T>(
  meta: { workspaceId: string; sessionId: string },
  fn: () => Promise<T>
): Promise<T> {
  const trace: VoiceTrace = {
    workspaceId: meta.workspaceId,
    sessionId: meta.sessionId,
    startedAt: performance.now(),
    marks: [],
  }

  const emit = (outcome: 'ok' | 'error') => {
    const totalMs = Math.round(performance.now() - trace.startedAt)
    const timings = computeTimings(trace.marks, totalMs)
    console.log(
      '[caye-voice] turn_timeline',
      JSON.stringify({
        workspaceId: trace.workspaceId,
        sessionId: trace.sessionId,
        outcome,
        ...timings,
        marks: trace.marks,
        at: new Date().toISOString(),
      })
    )
  }

  return store.run(trace, async () => {
    mark('request_received')
    try {
      const result = await fn()
      mark('response_sent')
      emit('ok')
      return result
    } catch (err) {
      emit('error')
      throw err
    }
  })
}

/** Test seam: run `fn` in a trace and hand back the marks instead of logging. */
export async function captureVoiceTurnMarks<T>(
  fn: () => Promise<T>
): Promise<{ result: T; marks: VoiceMark[] }> {
  const trace: VoiceTrace = { workspaceId: 'test', sessionId: 'test', startedAt: performance.now(), marks: [] }
  const result = await store.run(trace, fn)
  return { result, marks: trace.marks }
}
