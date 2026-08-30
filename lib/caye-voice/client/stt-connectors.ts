'use client'

import type { SttCredential } from '../types'

export interface SttSession {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  onPartial(cb: (text: string) => void): void
  onFinal(cb: (text: string) => void): void
  onSpeechStart(cb: () => void): void
  onSpeechEnd(cb: () => void): void
  onError(cb: (err: Error) => void): void
  /**
   * Fires when the first byte of Caye's own output audio arrives for a
   * response — the truest available "the founder can now hear something"
   * signal, and the endpoint of the speech-end -> first-audio metric the
   * latency targets are stated in. Providers without native voice output
   * never fire it.
   */
  onSpeechAudioStart(cb: () => void): void
  getMicStream(): MediaStream | null
  supportsNativeVoice(): boolean
  speakReply(text: string): Promise<void>
  cancelSpeech(): void
}

abstract class BaseSttSession implements SttSession {
  protected micStream: MediaStream | null = null
  protected partialCb: ((text: string) => void) | null = null
  protected finalCb: ((text: string) => void) | null = null
  protected speechStartCb: (() => void) | null = null
  protected speechEndCb: (() => void) | null = null
  protected errorCb: ((err: Error) => void) | null = null
  protected speechAudioStartCb: (() => void) | null = null
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
  onSpeechAudioStart(cb: () => void): void { this.speechAudioStartCb = cb }
  getMicStream(): MediaStream | null { return this.micStream }
  supportsNativeVoice(): boolean { return false }
  async speakReply(_text: string): Promise<void> { throw new Error('Native voice is unavailable for this provider') }
  cancelSpeech(): void {}
}

export class OpenAiRealtimeSttSession extends BaseSttSession {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private pendingSpeech: { resolve: () => void; reject: (err: Error) => void } | null = null
  /** Reset per response so onSpeechAudioStart fires once per reply, not once per session. */
  private audioStartedThisResponse = false

  constructor(private readonly credential: SttCredential) {
    super()
  }

  supportsNativeVoice(): boolean {
    return this.credential.connect.mode === 'native-voice'
  }

  async start(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const pc = new RTCPeerConnection()
    this.pc = pc
    this.micStream.getTracks().forEach((track) => pc.addTrack(track, this.micStream as MediaStream))

    if (this.supportsNativeVoice()) {
      const audio = new Audio()
      audio.autoplay = true
      this.remoteAudio = audio
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track])
        audio.srcObject = stream
        void audio.play().catch(() => {})
      }
    }

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = (event) => this.handleEvent(event.data)
    dc.onerror = () => this.errorCb?.(new Error('OpenAI Realtime data channel error'))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const form = new FormData()
    form.append('sdp', offer.sdp ?? '')
    const res = await fetch(this.credential.connect.callsUrl, {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${this.credential.token}` },
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500)
      throw new Error(`OpenAI Realtime connect failed: ${res.status}${detail ? ` ${detail}` : ''}`)
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  }

  async speakReply(text: string): Promise<void> {
    if (!this.supportsNativeVoice()) throw new Error('Native OpenAI voice session is not enabled')
    const dc = this.dc
    if (!dc || dc.readyState !== 'open') throw new Error('OpenAI Realtime data channel is not ready')
    if (!text.trim()) return

    this.cancelSpeech()
    this.audioStartedThisResponse = false
    await new Promise<void>((resolve, reject) => {
      this.pendingSpeech = { resolve, reject }
      dc.send(JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          max_output_tokens: 900,
          instructions:
            'You are voicing an already-authorized reply from Caye. Speak the reply naturally and conversationally. Preserve every factual claim and action status. Do not add facts, promises, tool results, or follow-up work. Prefer a compact spoken delivery when the reply is verbose, but never omit a warning, approval requirement, failure, or uncertainty. Caye backend reply:\n\n' + text,
        },
      }))
    })
  }

  cancelSpeech(): void {
    // OpenAI returns a session error when response.cancel is sent while no
    // response is active. Speech-start fires for every founder utterance,
    // including the first one, so cancellation must be conditional on an
    // actual in-flight native voice response.
    if (this.pendingSpeech && this.dc?.readyState === 'open' && this.supportsNativeVoice()) {
      try { this.dc.send(JSON.stringify({ type: 'response.cancel' })) } catch {}
    }
    this.pendingSpeech?.resolve()
    this.pendingSpeech = null
  }

  stop(): void {
    this.cancelSpeech()
    if (this.remoteAudio) {
      this.remoteAudio.pause()
      this.remoteAudio.srcObject = null
      this.remoteAudio = null
    }
    this.dc?.close()
    this.pc?.close()
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.pc = null
    this.dc = null
    this.micStream = null
  }

  private handleEvent(raw: string): void {
    let msg: { type?: string; delta?: string; transcript?: string; error?: { message?: string } }
    try { msg = JSON.parse(raw) } catch { return }

    // Both spellings are accepted: the realtime API renamed its output
    // audio delta event, and which one arrives depends on the model
    // version pinned by CAYE_VOICE_OPENAI_REALTIME_MODEL. Matching only
    // one would silently drop the first-audio metric on the other.
    if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
      if (!this.audioStartedThisResponse) {
        this.audioStartedThisResponse = true
        this.speechAudioStartCb?.()
      }
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
      case 'response.done':
        this.pendingSpeech?.resolve()
        this.pendingSpeech = null
        break
      case 'error': {
        const message = msg.error?.message || 'OpenAI Realtime session error'
        // Barge-in and preamble replacement can race with the provider's
        // response.done event. In that window response.cancel is semantically
        // correct but OpenAI may report that there is no longer an active
        // response. That is a harmless stale-cancel acknowledgement, not a
        // failed voice session, and must never poison the next pending reply.
        if (/cancellation failed:\s*no active response found/i.test(message)) break
        const err = new Error(message)
        this.pendingSpeech?.reject(err)
        this.pendingSpeech = null
        this.errorCb?.(err)
        break
      }
      default:
        break
    }
  }
}

export class DeepgramSttSession extends BaseSttSession {
  private ws: WebSocket | null = null
  private recorder: MediaRecorder | null = null
  private finalizedThisUtterance = false
  private committedSegments = ''
  private interimText = ''

  constructor(private readonly credential: SttCredential) { super() }

  async start(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ws = new WebSocket(this.credential.connect.wsUrl, ['bearer', this.credential.token])
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Deepgram WebSocket connect failed'))
    })
    ws.onmessage = (event) => this.handleMessage(event.data)
    ws.onerror = () => this.errorCb?.(new Error('Deepgram WebSocket error'))
    ws.onclose = () => { this.ws = null }

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
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'SpeechStarted') {
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
          this.finalCb?.([this.committedSegments, transcript].filter(Boolean).join(' ').trim())
        }
        this.committedSegments = ''
        this.interimText = ''
      } else if (msg.is_final) {
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
