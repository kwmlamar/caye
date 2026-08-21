'use client'

/**
 * Streaming TTS playback with genuine barge-in (spec items 5/11).
 *
 * One MediaSource per Caye reply. The reply's text is split into
 * sentences (splitIntoSentences below) and each sentence's audio is
 * fetched from /api/founder/caye-direct/voice/tts and appended to a single
 * continuous SourceBuffer as its bytes arrive — playback starts as soon as
 * the FIRST sentence's first chunk lands, not after the whole reply is
 * synthesized. `stop()` is immediate: pause the element, abort every
 * in-flight fetch, and tear down the MediaSource, no fade and no waiting
 * for the current sentence to finish (spec item 5: "Do not wait for the
 * full generated audio to finish").
 *
 * mp3-over-MSE across independently-fetched chunks is the pragmatic v1
 * choice (both ElevenLabs and Deepgram stream audio/mpeg over plain HTTP,
 * so no provider-specific transport code is needed here) — it is not
 * perfectly gapless the way a single continuous provider stream or fMP4
 * segments would be. If real sessions surface audible seams between
 * sentences, the documented next step is WebCodecs/AudioWorklet PCM
 * playback instead of MSE; noted in the implementation report as a known
 * limitation, not fixed here.
 */

export function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parts = trimmed.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [trimmed]
  return parts.map((s) => s.trim()).filter(Boolean)
}

export interface TtsFetchArgs {
  text: string
  provider: string
  workspaceId: string
  sessionId: string
}

export type TtsFetcher = (args: TtsFetchArgs, signal: AbortSignal) => Promise<Response>

export class TtsPlaybackController {
  private audioEl: HTMLAudioElement
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private abortController: AbortController | null = null
  private appendQueue: ArrayBuffer[] = []
  private appending = false
  private stopped = false
  private onDoneCb: (() => void) | null = null

  constructor(private readonly fetchTts: TtsFetcher) {
    this.audioEl = new Audio()
    this.audioEl.autoplay = false
  }

  getAudioElement(): HTMLAudioElement {
    return this.audioEl
  }

  onDone(cb: () => void): void {
    this.onDoneCb = cb
  }

  /** Immediate stop — the barge-in path. Must return synchronously fast. */
  stop(): void {
    this.stopped = true
    this.abortController?.abort()
    this.abortController = null
    try {
      this.audioEl.pause()
    } catch {
      // ignore
    }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream()
      } catch {
        // ignore — already ending or buffer mid-update
      }
    }
    this.appendQueue = []
    this.mediaSource = null
    this.sourceBuffer = null
    this.audioEl.removeAttribute('src')
    this.audioEl.load()
  }

  async speak(fullText: string, provider: string, workspaceId: string, sessionId: string): Promise<void> {
    this.stopped = false
    const sentences = splitIntoSentences(fullText)
    if (sentences.length === 0) return

    this.mediaSource = new MediaSource()
    this.audioEl.src = URL.createObjectURL(this.mediaSource)
    this.abortController = new AbortController()

    await new Promise<void>((resolve) => {
      if (!this.mediaSource) return resolve()
      this.mediaSource.addEventListener('sourceopen', () => resolve(), { once: true })
    })
    if (this.stopped || !this.mediaSource) return

    this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg')
    this.sourceBuffer.addEventListener('updateend', () => this.drainAppendQueue())

    let startedPlayback = false
    for (const sentence of sentences) {
      if (this.stopped) return
      const res = await this.fetchTts({ text: sentence, provider, workspaceId, sessionId }, this.abortController.signal)
      if (this.stopped) return
      if (!res.ok || !res.body) throw new Error(`TTS fetch failed: ${res.status}`)

      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (this.stopped) return
        if (done) break
        if (value) this.appendQueue.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
        this.drainAppendQueue()
        if (!startedPlayback) {
          startedPlayback = true
          this.audioEl.play().catch(() => {})
        }
      }
    }

    if (!this.stopped && this.mediaSource?.readyState === 'open' && !this.appending && this.appendQueue.length === 0) {
      try {
        this.mediaSource.endOfStream()
      } catch {
        // ignore
      }
    }
    this.audioEl.addEventListener(
      'ended',
      () => {
        if (!this.stopped) this.onDoneCb?.()
      },
      { once: true }
    )
  }

  private drainAppendQueue(): void {
    if (this.appending || this.stopped) return
    const buf = this.sourceBuffer
    if (!buf || buf.updating) return
    const next = this.appendQueue.shift()
    if (!next) return
    this.appending = true
    try {
      buf.appendBuffer(next)
    } catch {
      this.appending = false
      return
    }
    this.appending = false
  }
}
