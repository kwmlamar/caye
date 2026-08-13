'use client'

import { useCallback, useRef, useState } from 'react'
import { CayePresence, type CayePresenceState } from '@/components/caye-presence/CayePresence'
import { ENV_BG, TEXT, TEXT_MUTED, AQUA, GOLD, ROSE } from '@/components/dashboard/surface'

const STATES: CayePresenceState[] = ['idle', 'listening', 'thinking', 'speaking']

/**
 * Dev-only harness for CayePresence. Not linked from anywhere in the
 * product — visit directly at /dev/caye-presence. Exists because there is
 * no real Caye voice output to test `speaking` against yet (see
 * voice-calling-roadmap.md); this drives listening/speaking off a live
 * microphone stream instead, standing in for a future TTS playback tap.
 */
export default function CayePresenceDemoClient() {
  const [state, setState] = useState<CayePresenceState>('idle')
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const toggleMic = useCallback(async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setMicStream(null)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setMicStream(stream)
      setMicError(null)
    } catch {
      setMicError('Microphone permission denied or unavailable.')
    }
  }, [])

  return (
    <main
      style={{
        minHeight: '100vh', background: ENV_BG, color: TEXT,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32, padding: '64px 24px',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 560 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase', color: AQUA }}>
          Caye Presence — dev harness
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, margin: '8px 0' }}>
          Idle · listening · thinking · speaking
        </h1>
        <p style={{ fontSize: 13, color: TEXT_MUTED, lineHeight: 1.6 }}>
          Caye has no live voice output yet (see <code>voice-calling-roadmap.md</code>) — there is nothing
          real to wire &quot;speaking&quot; to. Turn on the microphone below and talk to drive{' '}
          <code>listening</code>/<code>speaking</code> off real amplitude instead. When TTS playback exists,
          swap this demo&apos;s mic <code>MediaStream</code> for that pipeline&apos;s own{' '}
          <code>AnalyserNode</code> — the <code>CayePresence</code> API doesn&apos;t change either way.
        </p>
      </div>

      <CayePresence state={state} size="large" audioSource={micStream} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {STATES.map((s) => (
          <button
            key={s}
            onClick={() => setState(s)}
            style={{
              padding: '8px 16px', borderRadius: 999, fontSize: 12.5, fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer',
              border: `1px solid ${state === s ? AQUA : 'rgba(255,255,255,0.14)'}`,
              background: state === s ? 'rgba(78,190,206,0.14)' : 'transparent',
              color: state === s ? AQUA : TEXT_MUTED,
              transition: 'all 0.15s ease',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button
          onClick={toggleMic}
          style={{
            padding: '10px 20px', borderRadius: 999, fontSize: 12.5, fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer',
            border: `1px solid ${micStream ? GOLD : 'rgba(255,255,255,0.14)'}`,
            background: micStream ? 'rgba(255,228,175,0.14)' : 'transparent',
            color: micStream ? GOLD : TEXT_MUTED,
          }}
        >
          {micStream ? 'Stop microphone' : 'Use microphone (live amplitude demo)'}
        </button>
        {micError && <span style={{ fontSize: 12, color: ROSE }}>{micError}</span>}
      </div>
    </main>
  )
}
