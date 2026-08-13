'use client'

import { useEffect, useRef } from 'react'
import { computeLevel } from './audio-level'

/** Anything CayePresence can listen to. An `AnalyserNode` lets a caller
 *  that already owns an audio graph (e.g. a future TTS playback pipeline)
 *  hand over just the tap point instead of losing control of routing. */
export type CayePresenceAudioSource = HTMLMediaElement | MediaStream | AnalyserNode | null | undefined

// A page may mount/unmount CayePresence instances repeatedly (route
// changes, thread switches). Browsers cap concurrent AudioContexts, and
// calling `createMediaElementSource` twice on the same <audio>/<video>
// element throws forever after — both problems disappear if every
// instance shares one context that's created once and never closed.
let sharedCtx: AudioContext | null = null
function getSharedAudioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    sharedCtx = new Ctor()
  }
  return sharedCtx
}

// createMediaElementSource throws InvalidStateError if called a second
// time on the same element, for the lifetime of that element — not just
// per AudioContext. Cache globally so remounts reuse the existing node.
const elementSourceCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()

/** Wires `source` into the shared audio graph and returns a stable
 *  `getLevel()` accessor (0..1, unsmoothed) meant to be polled once per
 *  animation frame — never through React state, so audio never triggers a
 *  re-render. Handles its own connect/disconnect on source change/unmount. */
export function useAudioLevelSource(source: CayePresenceAudioSource): () => number {
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  useEffect(() => {
    if (!source) {
      analyserRef.current = null
      dataRef.current = null
      return
    }

    if (source instanceof AnalyserNode) {
      analyserRef.current = source
      dataRef.current = new Uint8Array(source.frequencyBinCount)
      return
    }

    const ctx = getSharedAudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0 // caller does its own attack/release smoothing

    let mediaSource: MediaStreamAudioSourceNode | MediaElementAudioSourceNode

    if (source instanceof MediaStream) {
      mediaSource = ctx.createMediaStreamSource(source)
      mediaSource.connect(analyser)
      // Deliberately not connected to ctx.destination — this is almost
      // always a live mic input (demo/listening mode), and routing it to
      // speakers would feed back.
    } else {
      const cached = elementSourceCache.get(source)
      mediaSource = cached ?? ctx.createMediaElementSource(source)
      if (!cached) elementSourceCache.set(source, mediaSource)
      mediaSource.connect(analyser)
      // Playback element — route through so it stays audible; an
      // analyser tap alone doesn't reach the speakers.
      analyser.connect(ctx.destination)
    }

    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    analyserRef.current = analyser
    dataRef.current = new Uint8Array(analyser.frequencyBinCount)

    return () => {
      analyser.disconnect()
      try {
        mediaSource.disconnect(analyser)
      } catch {
        // already disconnected
      }
      if (analyserRef.current === analyser) {
        analyserRef.current = null
        dataRef.current = null
      }
    }
  }, [source])

  return () => {
    const analyser = analyserRef.current
    const data = dataRef.current
    if (!analyser || !data) return 0
    analyser.getByteFrequencyData(data)
    return computeLevel(data)
  }
}
