'use client'

import { useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/supabase'

type RecorderState = 'idle' | 'recording' | 'transcribing'

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export default function CayeVoiceNoteButton({ disabled, onTranscript }: { disabled?: boolean; onTranscript: (text: string) => void }) {
  const [state, setState] = useState<RecorderState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>(Array(34).fill(0.16))
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function cleanupVisualization() {
    if (animationRef.current != null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
  }

  function cleanupStream() {
    cleanupVisualization()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  useEffect(() => () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    cleanupStream()
  }, [])

  async function transcribe(blob: Blob) {
    setState('transcribing')
    try {
      const { session } = await getSession()
      if (!session) throw new Error('no session')
      const form = new FormData()
      const extension = blob.type.includes('mp4') ? 'm4a' : 'webm'
      form.set('audio', new File([blob], `voice-note.${extension}`, { type: blob.type || 'audio/webm' }))
      const response = await fetch('/api/founder/caye-direct/voice/transcribe-note', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` }, body: form })
      const json = await response.json().catch(() => null)
      if (!response.ok || typeof json?.transcript !== 'string') throw new Error(json?.error || 'Could not transcribe voice note')
      onTranscript(json.transcript)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not transcribe voice note')
    } finally {
      setState('idle')
      setElapsed(0)
    }
  }

  function beginVisualization(stream: MediaStream) {
    const context = new AudioContext()
    audioContextRef.current = context
    const analyser = context.createAnalyser()
    analyser.fftSize = 128
    analyser.smoothingTimeConstant = 0.72
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Uint8Array(analyser.frequencyBinCount)
    const draw = () => {
      analyser.getByteFrequencyData(samples)
      const next = Array.from({ length: 34 }, (_, index) => {
        const sample = samples[Math.floor((index / 34) * samples.length)] ?? 0
        return Math.max(0.14, Math.min(1, sample / 150))
      })
      setLevels(next)
      animationRef.current = requestAnimationFrame(draw)
    }
    draw()
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed((value) => value + 1), 1000)
  }

  async function start() {
    if (disabled || state !== 'idle') return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' })
        chunksRef.current = []
        cleanupStream()
        recorderRef.current = null
        if (blob.size > 0) void transcribe(blob)
        else setState('idle')
      }
      recorder.start()
      beginVisualization(stream)
      setState('recording')
    } catch {
      cleanupStream()
      setError('Microphone access is required')
      setState('idle')
    }
  }

  function stop() { if (recorderRef.current?.state === 'recording') recorderRef.current.stop() }

  const isRecording = state === 'recording'
  const isTranscribing = state === 'transcribing'
  const label = isRecording ? 'Stop voice note' : isTranscribing ? 'Transcribing voice note' : 'Record voice note'

  if (isRecording) {
    return (
      <div role="group" aria-label="Recording voice note" style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 238, height: 38, padding: '0 5px 0 12px', borderRadius: 999, background: 'rgba(255,255,255,0.045)' }}>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: '#8e8e96', minWidth: 28 }}>{formatDuration(elapsed)}</span>
        <div aria-hidden style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', gap: 2, overflow: 'hidden' }}>
          {levels.map((level, index) => <span key={index} style={{ width: 2, height: `${Math.max(3, Math.round(level * 23))}px`, borderRadius: 999, background: 'rgba(244,244,245,0.55)', transition: 'height 70ms linear' }} />)}
        </div>
        <button type="button" onClick={stop} title="Stop voice note" aria-label="Stop voice note" style={{ width: 31, height: 31, flex: '0 0 auto', display: 'grid', placeItems: 'center', border: '1px solid rgba(78,190,206,0.7)', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', cursor: 'pointer' }}>
          <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, background: '#f87171' }} />
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled || isTranscribing}
      title={error || label}
      aria-label={label}
      className="caye-direct-send"
      style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}
    >
      {isTranscribing ? <span aria-hidden style={{ width: 13, height: 13, border: '2px solid rgba(244,244,245,0.25)', borderTopColor: '#4EBECE', borderRadius: '50%', animation: 'caye-attachment-spin .7s linear infinite' }} /> : <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(244,244,245,0.6)" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></svg>}
    </button>
  )
}