'use client'

import { getSession } from '@/lib/supabase'

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

export interface VoiceClientMetrics {
  speechEndToFinalTranscriptMs: number | null
  requestRoundTripMs: number | null
  replyToPlaybackRequestedMs: number | null
  replyToFirstAudioMs: number | null
  speechEndToFirstAudioMs: number | null
  speechEndToPreambleMs: number | null
  totalTurnMs: number | null
}

export class VoiceTurnTimeline {
  private marks: VoiceClientMark[] = []
  private origin = 0
  private started = false

  begin(): void {
    this.origin = performance.now()
    this.marks = []
    this.started = true
    this.record('speech_start')
  }

  record(stage: VoiceClientStage): void {
    if (!this.started) return
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

  flush(args: { workspaceId: string; sessionId: string; backend?: string | null; accessToken?: string | null }): void {
    if (!this.started || this.marks.length === 0) return
    const payload = {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      backend: args.backend ?? null,
      ...this.snapshot(),
    }
    this.started = false

    if (typeof console !== 'undefined') console.info('[caye-voice] client_timeline', payload)

    // Telemetry is founder-only too. Most callers do not carry the token
    // around because it is irrelevant to the voice state machine, so resolve
    // the current session here rather than silently sending an unauthenticated
    // request that production rejects with 403.
    void (async () => {
      try {
        let accessToken = args.accessToken ?? null
        if (!accessToken) {
          const { session } = await getSession()
          accessToken = session?.access_token ?? null
        }
        if (!accessToken) return
        await fetch('/api/founder/caye-direct/voice/telemetry', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
          keepalive: true,
        })
      } catch {
        // Observability must never affect a live conversation.
      }
    })()
  }
}
