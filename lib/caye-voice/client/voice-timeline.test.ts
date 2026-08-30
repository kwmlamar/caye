import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { VoiceTurnTimeline } from './voice-timeline'

/** Drives the clock so the derived metrics are exact rather than flaky. */
function withClock() {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return { advance: (ms: number) => { now += ms } }
}

describe('VoiceTurnTimeline', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('computes the speech-end -> first-audio number the targets are stated in', () => {
    const clock = withClock()
    const t = new VoiceTurnTimeline()
    t.begin()
    clock.advance(1400)
    t.record('speech_end')
    clock.advance(300)
    t.record('transcript_final')
    t.record('request_start')
    clock.advance(500)
    t.record('request_end')
    t.record('playback_requested')
    clock.advance(180)
    t.record('first_audible_audio')

    const m = t.metrics()
    expect(m.speechEndToFinalTranscriptMs).toBe(300)
    expect(m.requestRoundTripMs).toBe(500)
    expect(m.replyToFirstAudioMs).toBe(180)
    expect(m.speechEndToFirstAudioMs).toBe(980)
  })

  it('measures the preamble separately, so a covered slow turn is not scored as fast', () => {
    const clock = withClock()
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('speech_end')
    clock.advance(900)
    t.record('preamble_spoken')
    clock.advance(11000)
    t.record('request_end')
    clock.advance(200)
    t.record('first_audible_audio')

    const m = t.metrics()
    expect(m.speechEndToPreambleMs).toBe(900)
    // The real answer still took 12.1s — the preamble does not hide that.
    expect(m.speechEndToFirstAudioMs).toBe(12100)
  })

  it('reports null instead of inventing a number when a stage never fired', () => {
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('speech_end')
    const m = t.metrics()
    expect(m.speechEndToFirstAudioMs).toBeNull()
    expect(m.requestRoundTripMs).toBeNull()
  })

  it('ignores marks before begin(), so a stray event cannot open a turn', () => {
    const t = new VoiceTurnTimeline()
    t.record('speech_end')
    expect(t.snapshot().marks).toEqual([])
  })

  it('keeps only the first partial transcript, but every other repeat', () => {
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('transcript_partial_first')
    t.record('transcript_partial_first')
    t.record('transcript_partial_first')
    t.record('first_audible_audio')
    t.record('first_audible_audio')
    const stages = t.snapshot().marks.map((m) => m.stage)
    expect(stages.filter((s) => s === 'transcript_partial_first')).toHaveLength(1)
    expect(stages.filter((s) => s === 'first_audible_audio')).toHaveLength(2)
  })

  it('restarts cleanly on barge-in so the next turn is timed from its own onset', () => {
    const clock = withClock()
    const t = new VoiceTurnTimeline()
    t.begin()
    clock.advance(5000)
    t.record('barge_in')
    t.begin()
    clock.advance(400)
    t.record('speech_end')
    clock.advance(100)
    t.record('first_audible_audio')
    expect(t.metrics().speechEndToFirstAudioMs).toBe(100)
    expect(t.snapshot().marks[0].stage).toBe('speech_start')
  })

  it('flushes once and then goes quiet until the next turn begins', () => {
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('speech_end')
    t.flush({ workspaceId: 'ws-1', sessionId: 'voice_1' })
    t.flush({ workspaceId: 'ws-1', sessionId: 'voice_1' })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('never lets a telemetry failure reach the conversation', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('speech_end')
    expect(() => t.flush({ workspaceId: 'ws-1', sessionId: 'voice_1' })).not.toThrow()
  })

  it('sends timings only — no transcript, no reply text', () => {
    const t = new VoiceTurnTimeline()
    t.begin()
    t.record('speech_end')
    t.record('first_audible_audio')
    t.flush({ workspaceId: 'ws-1', sessionId: 'voice_1', backend: 'openai_api' })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(Object.keys(body).sort()).toEqual(['backend', 'marks', 'metrics', 'sessionId', 'workspaceId'])
    expect(body.marks.every((m: Record<string, unknown>) => typeof m.atMs === 'number')).toBe(true)
  })
})
