import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSttSession } from './stt-connectors'
import type { SttCredential } from '../types'

// Regression guard for the 2026-08-17 live-test failure: the Deepgram
// connector was sending the ephemeral JWT (from POST /v1/auth/grant) over
// the WRONG WebSocket subprotocol (`token`, which is only valid for a raw,
// long-lived account API key). Confirmed live that `bearer` is the correct
// scheme for a JWT — see stt-connectors.ts's DeepgramSttSession doc
// comment. This test never touches the network; it only asserts what
// value the connector passes into the WebSocket constructor.

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string, public protocols?: string[]) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  close() {}
}

describe('DeepgramSttSession — WebSocket auth scheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
  })

  it('connects with the `bearer` subprotocol for the ephemeral JWT, not `token`', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })) } })
    vi.stubGlobal(
      'MediaRecorder',
      class {
        ondataavailable: (() => void) | null = null
        start() {}
        stop() {}
      }
    )

    const credential: SttCredential = {
      provider: 'deepgram',
      token: 'fake-jwt',
      expiresAt: new Date().toISOString(),
      connect: { wsUrl: 'wss://api.deepgram.com/v1/listen?model=nova-3' },
    }
    const session = createSttSession(credential)
    await session.start()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].protocols).toEqual(['bearer', 'fake-jwt'])
    expect(FakeWebSocket.instances[0].protocols).not.toEqual(['token', 'fake-jwt'])
  })
})

// Regression guard for the SECOND 2026-08-17 live-test bug: one real
// utterance with a mid-sentence pause produced THREE `is_final: true`
// Results events and TWO separate Caye replies, because the old code
// treated every `is_final` segment as a complete turn. The fix gates
// finalization on `speech_final` (Deepgram's actual end-of-turn signal),
// using UtteranceEnd only as a fallback when speech_final never arrives.
describe('DeepgramSttSession — message handling (is_final vs speech_final)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
  })

  async function setupSession() {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })) } })
    vi.stubGlobal(
      'MediaRecorder',
      class {
        ondataavailable: (() => void) | null = null
        start() {}
        stop() {}
      }
    )
    const credential: SttCredential = {
      provider: 'deepgram',
      token: 'fake-jwt',
      expiresAt: new Date().toISOString(),
      connect: { wsUrl: 'wss://api.deepgram.com/v1/listen?model=nova-3' },
    }
    const session = createSttSession(credential)
    await session.start()
    const ws = FakeWebSocket.instances[0]
    const send = (msg: unknown) => ws.onmessage?.({ data: JSON.stringify(msg) })
    return { session, send }
  }

  it('concatenates across a mid-utterance segment boundary instead of overwriting — the exact live failure: real Deepgram data showed a segment-boundary is_final RESETS the transcript field to just that segment\'s words, not the words-so-far, so a naive overwrite lost everything spoken before the boundary', async () => {
    const { session, send } = await setupSession()
    const finals: string[] = []
    const partials: string[] = []
    session.onFinal((t) => finals.push(t))
    session.onPartial((t) => partials.push(t))

    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hey, Caye. What are' }] } })
    // Segment boundary (is_final true, speech_final false/absent) — real
    // Deepgram data shows this segment's OWN transcript field, not the
    // full sentence-so-far. A second SpeechStarted (VAD restarting
    // mid-utterance, also observed live) follows immediately, which must
    // NOT wipe what was already committed.
    send({ type: 'Results', is_final: true, speech_final: false, channel: { alternatives: [{ transcript: 'Hey, Caye. What are we' }] } })
    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'currently trying' }] } })
    // Final segment's transcript is ALSO just its own words, not the
    // whole sentence — matches the real live event log exactly.
    send({
      type: 'Results',
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'currently trying to recover?' }] },
    })

    expect(finals).toEqual(['Hey, Caye. What are we currently trying to recover?'])
    expect(finals).toHaveLength(1)
    // The live caption should have shown the growing, concatenated text
    // throughout — never just the isolated final segment.
    expect(partials.some((p) => p.startsWith('Hey, Caye. What are we'))).toBe(true)
  })

  it('never fires onFinal twice for the same utterance even if UtteranceEnd arrives after speech_final', async () => {
    const { session, send } = await setupSession()
    const finals: string[] = []
    session.onFinal((t) => finals.push(t))

    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Send that to her.' }] } })
    send({ type: 'UtteranceEnd' })

    expect(finals).toEqual(['Send that to her.'])
  })

  it('falls back to UtteranceEnd with the last known transcript when speech_final never arrives', async () => {
    const { session, send } = await setupSession()
    const finals: string[] = []
    session.onFinal((t) => finals.push(t))

    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'What decision do you need' }] } })
    send({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'What decision do you need from Mrs. Max' }] } })
    send({ type: 'UtteranceEnd' })

    expect(finals).toEqual(['What decision do you need from Mrs. Max'])
  })

  it('resets the finalized guard on the next SpeechStarted, so a second real utterance still sends', async () => {
    const { session, send } = await setupSession()
    const finals: string[] = []
    session.onFinal((t) => finals.push(t))

    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'First turn.' }] } })
    send({ type: 'SpeechStarted' })
    send({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Second turn.' }] } })

    expect(finals).toEqual(['First turn.', 'Second turn.'])
  })
})
