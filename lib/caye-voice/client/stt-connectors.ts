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
    const sdp = offer.sdp ?? ''
    const form = new FormData()
    // OpenAI expects `sdp` as a normal multipart text field. Appending a
    // Blob turns it into a file part, which the API does not bind to its
    // required string parameter and therefore reports `sdp` as missing.
    form.append('sdp', sdp)

    const res = await fetch(callsUrl, {
      method: 'POST',
      body: form,
      headers: {
        Authorization: `Bearer ${this.credential.token}`,
      },
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500)
      throw new Error(`OpenAI Realtime connect failed: ${res.status}${detail ? ` ${detail}` : ''}`)
    }
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

export class DeepgramSttSession extends BaseSttSession {
  private ws: WebSocket | null = null
  private recorder: MediaRecorder | null = null
  private finalizedThisUtterance = false
  private committedSegments = ''
  private interimText = ''

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
