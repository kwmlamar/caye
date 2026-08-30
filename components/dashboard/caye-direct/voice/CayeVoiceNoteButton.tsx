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

export default function CayeVoiceNoteButton({
  disabled,
  onTranscript,
}: {
  disabled?: boolean
  onTranscript: (text: string) => void
}) {
  const [state, setState] = useState<RecorderState>('idle')
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])

  function cleanupStream() {
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
      const response = await fetch('/api/founder/caye-direct/voice/transcribe-note', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || typeof json?.transcript !== 'string') {
        throw new Error(json?.error || 'Could not transcribe voice note')
      }
      onTranscript(json.transcript)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not transcribe voice note')
    } finally {
      setState('idle')
    }
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
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' })
        chunksRef.current = []
        cleanupStream()
        recorderRef.current = null
        if (blob.size > 0) void transcribe(blob)
        else setState('idle')
      }
      recorder.start()
      setState('recording')
    } catch {
      cleanupStream()
      setError('Microphone access is required')
      setState('idle')
    }
  }

  function stop() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  const isRecording = state === 'recording'
  const isTranscribing = state === 'transcribing'
  const label = isRecording ? 'Stop voice note' : isTranscribing ? 'Transcribing voice note' : 'Record voice note'

  return (
    <button
      type="button"
      onClick={isRecording ? stop : start}
      disabled={disabled || isTranscribing}
      title={error || label}
      aria-label={label}
      aria-pressed={isRecording}
      className={`caye-direct-send${isRecording ? ' is-recording' : ''}`}
    >
      {isTranscribing ? (
        <span aria-hidden style={{ width: 13, height: 13, border: '2px solid rgba(244,244,245,0.25)', borderTopColor: '#4EBECE', borderRadius: '50%', animation: 'caye-attachment-spin .7s linear infinite' }} />
      ) : isRecording ? (
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, background: '#f87171' }} />
      ) : (
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(244,244,245,0.6)" strokeWidth="2.2" strokeLinecap="round">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
        </svg>
      )}
    </button>
  )
}
