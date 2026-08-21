'use client'

import type { SttCredential } from '../types'

/**
 * Common interface both STT connectors implement, so useVoiceSession.ts
 * never branches on provider. Mirrors the spec's turn-detection states
 * (item 6): onSpeechStart/onSpeechEnd come from the provider's own server
 * VAD, not a hand-timed heuristic.
 */
export interface SttSession {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  onPartial(cb: (text: string) => void): void
  onFinal(cb: (text: string) => void): void
  onSpeechStart(cb: () => void): void
  onSpeechEnd(cb: () => void): void
  onError(cb: (err: Error) => void): void
  /** For CayePresence's `listening` visualization. */
  getMicStream(): MediaStream | null
}

abstract class BaseSttSession implements SttSession {
  protected micStream: MediaStream | null = null
  protected partialCb: ((text: string) => void) | null = null
  protected finalCb: ((text: string) => void) | null = null
  protected speechStartCb: (() => void) | null = null
  protected speechEndCb: (() => void) | null = null
  protected errorCb: ((err: Error) => void) | null = null
  protected muted = false

  abstract start(): Promise<void>
  abstract stop(): void

  setMuted(muted: boolean): void {
    this.muted = muted
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted))
  }
  onPartial(cb: (text: string) => void): void { this.partialCb = cb }
  onFinal(cb: (text: string) => void): void { this.finalCb = cb }
  onSpeechStart(cb: () => void): void { this.speechStartCb = cb }
  onSpeechEnd(cb: () => void): void { this.speechEndCb = cb }
  onError(cb: (err: Error) => void): void { this.errorCb = cb }
  getMicStream(): MediaStream | null { return this.micStream }
}

/**
 * OpenAI Realtime *transcription* session over WebRTC (spec item 1/9's
 * "native realtime path", scoped to transcription only — see
 * lib/caye-voice/providers.ts's mintOpenAiRealtimeCredential for why a
 * transcription session can never itself generate a response or call a
 * tool). Event names follow OpenAI's documented Realtime transcription
 * guide as of this build; not exercised against a live session in this
 * environment (no OPENAI_API_KEY configured here) — verify event names
 * against a real connection before relying on this in production.
 */
export class OpenAiRealtimeSttSession extends BaseSttSession {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null

  constructor(private readonly credential: SttCredential) {
    super()
  }

  async start(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const pc = new RTCPeerConnection()
    this.pc = pc
    this.micStream.getTracks().forEach((track) => pc.addTrack(track, this.micStream as MediaStream))

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (event) => this.handleEvent(event.data)
    dc.onerror = () => this.errorCb?.(new Error('OpenAI Realtime data channel error'))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const callsUrl = this.credential.connect.callsUrl
    const model = this.credential.connect.model
    const res = await fetch(`${callsUrl}?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${this.credential.token}`,
        'Content-Type': 'application/sdp',
      },
    })
    if (!res.ok) throw new Error(`OpenAI Realtime connect failed: ${res.status}`)
    const answerSdp = await res.text()
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
  }

  stop(): void {
    this.dc?.close()
    this.pc?.close()
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.pc = null
    this.dc = null
    this.micStream = null
  }

  private handleEvent(raw: string): void {
    let msg: { type?: string; delta?: string; transcript?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (msg.delta) this.partialCb?.(msg.delta)
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) this.finalCb?.(msg.transcript)
        break
      case 'input_audio_buffer.speech_started':
        this.speechStartCb?.()
        break
      case 'input_audio_buffer.speech_stopped':
        this.speechEndCb?.()
        break
      default:
        break
    }
  }
}

/**
 * Deepgram Nova streaming STT over a browser-direct WebSocket, authorized
 * with the short-lived JWT minted server-side via POST /v1/auth/grant
 * (never the account key). Browsers can't set custom WS headers, so the
 * token rides the Sec-WebSocket-Protocol list.
 *
 * IMPORTANT: the subprotocol value is `['bearer', token]`, NOT
 * `['token', token]`. `token` is Deepgram's scheme for a raw, long-lived
 * account API key; `bearer` is required for a short-lived JWT from
 * /auth/grant. Using `token` with a JWT fails the handshake outright
 * (`1002` close, "non-101 status code") — this is exactly what broke the
 * founder's first live test (2026-08-17): minting succeeded, but the
 * connector was still using the raw-key subprotocol from before the
 * /auth/grant migration. Confirmed empirically (not just from docs, which
 * don't clearly state this) by testing both subprotocol values plus a
 * `?access_token=` query-param variant against the real API — only
 * `bearer` opened successfully, and a full audio round trip through it
 * (real interim + final transcripts, real SpeechStarted VAD event)
 * confirmed live the same day.
 *
 * Audio capture uses MediaRecorder (webm/opus) rather than raw PCM to
 * avoid needing an AudioWorklet for this v1; Deepgram's Listen API
 * auto-detects the container, so no explicit encoding/sample_rate query
 * params are needed here (they would be required for raw PCM, which is
 * what the live audio round-trip test above actually sent — a test-only
 * difference from this browser path, not a functional gap). `UtteranceEnd`
 * specifically still wasn't observed in that PCM test — onFinal's own
 * dispatch of user_speech_end in useVoiceSession.ts remains a working
 * fallback either way.
 *
 * SECOND live-test bug, same day: `is_final: true` on a Results message
 * is NOT "the speaker is done" — see handleMessage's doc comment for the
 * full story (one real utterance produced two separate Caye replies
 * because the old code sent a turn on every `is_final` segment instead of
 * once on `speech_final`).
 */
export class DeepgramSttSession extends BaseSttSession {
  private ws: WebSocket | null = null
  private recorder: MediaRecorder | null = null
  private finalizedThisUtterance = false

  constructor(private readonly credential: SttCredential) {
    super()
  }

  async start(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const wsUrl = this.credential.connect.wsUrl
    const ws = new WebSocket(wsUrl, ['bearer', this.credential.token])
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Deepgram WebSocket connect failed'))
    })

    ws.onmessage = (event) => this.handleMessage(event.data)
    ws.onerror = () => this.errorCb?.(new Error('Deepgram WebSocket error'))
    ws.onclose = () => {
      this.ws = null
    }

    const recorder = new MediaRecorder(this.micStream, { mimeType: 'audio/webm;codecs=opus' })
    this.recorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        event.data.arrayBuffer().then((buf) => ws.send(buf))
      }
    }
    recorder.start(250)
  }

  stop(): void {
    this.recorder?.stop()
    this.recorder = null
    this.ws?.close()
    this.ws = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
  }

  /**
   * 2026-08-17 live-test bug #2: `is_final: true` on a Results message
   * means "this transcript SEGMENT is locked in," not "the speaker is
   * done." Deepgram finalizes multiple segments within one continuous
   * utterance at natural micro-pauses — a founder saying one sentence with
   * a brief pause mid-sentence produced THREE separate `is_final: true`
   * events live, and the old code called `finalCb` (which sends a full
   * turn to cayeAgent) on every one of them: two genuinely different Caye
   * replies came back for what was really one utterance. `speech_final:
   * true` is Deepgram's actual "the speaker has stopped talking" signal —
   * fires once per real utterance, gated by the same endpointing/VAD
   * logic. `finalizedThisUtterance` guards against firing `finalCb` twice
   * for one utterance (e.g. if UtteranceEnd arrives shortly after
   * speech_final already fired).
   *
   * THIRD live-test bug, same day, found while verifying the fix for the
   * second one: even after raising endpointing/utterance_end_ms so a
   * natural pause no longer triggers a premature `speech_final`, Deepgram
   * still emits an internal segment-boundary event — `Results` with
   * `is_final: true` but `speech_final: false` — partway through one
   * continuous utterance, and resets its OWN `transcript` field to just
   * that segment's words rather than the words-so-far. The old code
   * OVERWROTE `pendingTranscript` with every Results message, so once that
   * boundary event landed, everything spoken before it was gone — this is
   * exactly why the founder's full sentence arrived as only its last
   * clause. Reproduced deterministically with a synthesized 900ms
   * mid-sentence gap and the real event log inspected directly (not
   * guessed from docs) before landing this fix.
   *
   * Fix: `committedSegments` accumulates each locked-in segment's text
   * (every `is_final: true`, regardless of `speech_final`); `interimText`
   * holds the still-changing tail. The transcript surfaced to the caller —
   * for partials, the final callback, and the UtteranceEnd fallback — is
   * always `committedSegments` + `interimText` joined, never a single
   * segment in isolation. Only reset on a genuine end of turn
   * (speech_final or the UtteranceEnd fallback), never on SpeechStarted —
   * Deepgram's VAD can and does fire SpeechStarted again mid-utterance
   * (also observed live) well before the actual endpointing-based end, so
   * treating it as "start of a new utterance, discard everything so far"
   * was itself part of the bug.
   */
  private committedSegments = ''
  private interimText = ''

  private currentText(): string {
    return [this.committedSegments, this.interimText].filter(Boolean).join(' ').trim()
  }

  private handleMessage(raw: string): void {
    let msg: {
      type?: string
      is_final?: boolean
      speech_final?: boolean
      channel?: { alternatives?: Array<{ transcript?: string }> }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'SpeechStarted') {
      // Deliberately does NOT reset committedSegments/interimText — see
      // this method's doc comment. finalizedThisUtterance is reset so the
      // NEXT genuine end-of-turn (after this one has already fired, if it
      // has) is still able to finalize.
      this.finalizedThisUtterance = false
      this.speechStartCb?.()
      return
    }
    if (msg.type === 'UtteranceEnd') {
      const text = this.currentText()
      if (!this.finalizedThisUtterance && text) {
        this.finalizedThisUtterance = true
        this.finalCb?.(text)
      }
      this.committedSegments = ''
      this.interimText = ''
      this.speechEndCb?.()
      return
    }
    if (msg.type === 'Results') {
      const transcript = msg.channel?.alternatives?.[0]?.transcript
      if (!transcript) return
      if (msg.speech_final) {
        if (!this.finalizedThisUtterance) {
          this.finalizedThisUtterance = true
          const text = [this.committedSegments, transcript].filter(Boolean).join(' ').trim()
          this.finalCb?.(text)
        }
        this.committedSegments = ''
        this.interimText = ''
      } else if (msg.is_final) {
        // Segment boundary, not end of turn — lock it into the committed
        // prefix and clear the interim tail; the next segment starts fresh
        // but is now appended to, not substituted for, this one.
        this.committedSegments = [this.committedSegments, transcript].filter(Boolean).join(' ').trim()
        this.interimText = ''
        this.partialCb?.(this.currentText())
      } else {
        this.interimText = transcript
        this.partialCb?.(this.currentText())
      }
    }
  }
}

export function createSttSession(credential: SttCredential): SttSession {
  if (credential.provider === 'openai-realtime') return new OpenAiRealtimeSttSession(credential)
  if (credential.provider === 'deepgram') return new DeepgramSttSession(credential)
  throw new Error(`Unknown STT provider: ${credential.provider}`)
}
