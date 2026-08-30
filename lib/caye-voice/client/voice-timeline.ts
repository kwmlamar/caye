'use client'

/**
 * Browser half of the voice latency breakdown.
 *
 * The server half (lib/caye-voice/latency.ts) can only see "request
 * arrived" through "response sent". Everything the founder actually
 * experiences as lag lives on either side of that: how long after they
 * stopped talking the transcript was finalized, and how long after the
 * reply arrived the first audio was audible. This records those, computes
 * the derived numbers the investigation reasons about, and ships them to
 * the same log stream so one turn can be read end to end.
 *
 * Records timings only — never transcript or reply text.
 */

export type VoiceClientStage =
  | 'speech_start'
  | 'speech_end'
  | 'transcript_partial_first'
  | 'transcript_final'
  | 'request_start'
  | 'request_end'
  | 'preamble_spoken'
  | 'playback_requested'
  | 'first_audible_audio'
  | 'playback_ended'
  | 'barge_in'

export interface VoiceClientMark {
  stage: VoiceClientStage
  atMs: number
}

/** The metrics the performance targets are actually stated in. */
export interface VoiceClientMetrics {
  /** Turn detection tail: how long the founder waits after finishing a sentence for the transcript to finalize. */
  speechEndToFinalTranscriptMs: number | null
  /** Server round trip as the browser sees it, including network. */
  requestRoundTripMs: number | null
  /** Reply in hand -> playback asked to start. */
  replyToPlaybackRequestedMs: number | null
  /** Reply in hand -> founder actually hears something. */
  replyToFirstAudioMs: number | null
  /** THE number: stopped talking -> heard Caye. The 700ms/1.2s target is this one. */
  speechEndToFirstAudioMs: number | null
  /** Stopped talking -> heard the "checking now" preamble, when one was used. */
  speechEndToPreambleMs: number | null
  totalTurnMs: number | null
}

export class VoiceTurnTimeline {
  private marks: VoiceClientMark[] = []
  private origin = 0
  private started = false

  /** Begins a turn at the founder's speech onset. Restarts cleanly on barge-in. */
  begin(): void {
    this.origin = performance.now()
    this.marks = []
    this.started = true
    this.record('speech_start')
  }

  record(stage: VoiceClientStage): void {
    if (!this.started) return
    // First-partial is the only stage where a repeat is meaningless noise;
    // every other stage can legitimately recur and is worth keeping.
    if (stage === 'transcript_partial_first' && this.marks.some((m) => m.stage === stage)) return
    this.marks.push({ stage, atMs: Math.round(performance.now() - this.origin) })
  }

  private at(stage: VoiceClientStage): number | null {
    return this.marks.find((m) => m.stage === stage)?.atMs ?? null
  }

  private span(from: VoiceClientStage, to: VoiceClientStage): number | null {
    const a = this.at(from)
    const b = this.at(to)
    return a == null || b == null ? null : b - a
  }

  metrics(): VoiceClientMetrics {
    const speechEnd = this.at('speech_end')
    const firstAudio = this.at('first_audible_audio')
    const preamble = this.at('preamble_spoken')
    const lastMark = this.marks[this.marks.length - 1]
    return {
      speechEndToFinalTranscriptMs: this.span('speech_end', 'transcript_final'),
      requestRoundTripMs: this.span('request_start', 'request_end'),
      replyToPlaybackRequestedMs: this.span('request_end', 'playback_requested'),
      replyToFirstAudioMs: this.span('request_end', 'first_audible_audio'),
      speechEndToFirstAudioMs: speechEnd == null || firstAudio == null ? null : firstAudio - speechEnd,
      speechEndToPreambleMs: speechEnd == null || preamble == null ? null : preamble - speechEnd,
      totalTurnMs: lastMark?.atMs ?? null,
    }
  }

  snapshot(): { marks: VoiceClientMark[]; metrics: VoiceClientMetrics } {
    return { marks: [...this.marks], metrics: this.metrics() }
  }

  /**
   * Emit the turn. Logs to the browser console (so the founder can watch
   * numbers live with devtools open during a session) and best-effort POSTs
   * the same payload server-side so it lands next to `turn_timeline` in the
   * Vercel logs. Never throws and never blocks the conversation.
   */
  flush(args: { workspaceId: string; sessionId: string; backend?: string | null; accessToken?: string | null }): void {
    if (!this.started || this.marks.length === 0) return
    const payload = {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      backend: args.backend ?? null,
      ...this.snapshot(),
    }
    this.started = false

    if (typeof console !== 'undefined') {
      console.info('[caye-voice] client_timeline', payload)
    }

    try {
      void fetch('/api/founder/caye-direct/voice/telemetry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(args.accessToken ? { Authorization: `Bearer ${args.accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    } catch {
      // Telemetry is never allowed to affect the session.
    }
  }
}
