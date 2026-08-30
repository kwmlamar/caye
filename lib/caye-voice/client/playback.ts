'use client'

/**
 * Streaming TTS playback with genuine barge-in (spec items 5/11).
 *
 * Cloud TTS uses one MediaSource per Caye reply. The reply's text is split
 * into sentences (splitIntoSentences below) and each sentence's audio is
 * fetched from /api/founder/caye-direct/voice/tts and appended to a single
 * continuous SourceBuffer as its bytes arrive. When no cloud TTS key is
 * configured, the router selects `browser` and this controller uses the
 * browser's local SpeechSynthesis API instead, so live voice remains usable
 * without shipping a provider secret to the client.
 *
 * `stop()` is immediate for both paths: cloud fetch/playback is aborted and
 * browser speech is cancelled synchronously. That keeps barge-in semantics
 * intact whichever voice backend is active.
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
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
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
    if (!fullText.trim()) return

    if (provider === 'browser') {
      await this.speakWithBrowser(fullText)
      return
    }

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
    const startFetch = (sentence: string) =>
      this.fetchTts({ text: sentence, provider, workspaceId, sessionId }, this.abortController!.signal)

    // Sentence N+1's fetch is kicked off as soon as sentence N's response
    // headers arrive — before N's body is read/appended/played — so its
    // network latency overlaps with N's streaming instead of adding on
    // top of it. Sentences are still read and appended strictly in order.
    let nextFetch: Promise<Response> | null = startFetch(sentences[0])
    for (let i = 0; i < sentences.length; i++) {
      if (this.stopped) return
      const res = await nextFetch!
      nextFetch = i + 1 < sentences.length ? startFetch(sentences[i + 1]) : null
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

  private async speakWithBrowser(fullText: string): Promise<void> {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      throw new Error('Browser speech synthesis is unavailable')
    }

    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(fullText.trim())
      utterance.rate = 1
      utterance.pitch = 1
      utterance.volume = 1
      utterance.onend = () => {
        if (!this.stopped) this.onDoneCb?.()
        resolve()
      }
      utterance.onerror = (event) => {
        if (this.stopped || event.error === 'canceled' || event.error === 'interrupted') {
          resolve()
          return
        }
        reject(new Error(`Browser TTS failed: ${event.error}`))
      }

      // Clear any stale utterance left behind by an interrupted/abandoned
      // session before Caye starts the new response.
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(utterance)
    })
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
