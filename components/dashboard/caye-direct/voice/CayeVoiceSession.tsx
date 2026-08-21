'use client'

import { useEffect, useState } from 'react'
import { CayePresence, type CayePresenceState } from '@/components/caye-presence/CayePresence'
import { useVoiceSession } from '@/lib/caye-voice/client/useVoiceSession'
import type { VoiceUiState } from '@/lib/caye-voice/types'

const PRESENCE_STATE: Record<VoiceUiState, CayePresenceState> = {
  idle: 'idle',
  connecting: 'idle',
  listening: 'listening',
  'user-speaking': 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'idle',
}

const STATE_LABEL: Record<VoiceUiState, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  listening: 'Listening',
  'user-speaking': 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Something went wrong',
}

/**
 * Founder-only Live Voice panel (spec item 14). Reuses CayePresence — the
 * particle-sphere component already built with exactly these four states
 * and explicitly waiting for "a future TTS playback pipeline" to wire
 * `speaking` up (see CayePresence.tsx's doc comment) — rather than
 * inventing new visual language. No fake progress bars, no settings
 * beyond mute/end, per spec.
 *
 * Rendered inside CayeDirectThread (mode: 'thread' only) as an overlay
 * above the composer, not a separate view — the message list underneath
 * keeps scrolling/rendering normally, so voice is visibly "the same
 * conversation," not a separate Caye (spec item 8).
 */
export default function CayeVoiceSession({
  workspaceId,
  sendTurn,
  onClose,
}: {
  workspaceId: string
  sendTurn: (text: string, opts: { endpoint: string; sessionId: string }) => Promise<string | null>
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const voice = useVoiceSession({
    workspaceId,
    sendTurn,
    onError: (message) => setError(message),
  })

  useEffect(() => {
    void voice.start()
    return () => voice.end()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const audioSource = voice.state === 'speaking' ? voice.ttsAudioElement : voice.micStream ?? undefined

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '18px 20px 16px', borderRadius: 18,
        background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 10px 28px -12px rgba(0,0,0,0.5)',
      }}
      role="region"
      aria-label="Caye live voice session"
    >
      <CayePresence state={PRESENCE_STATE[voice.state]} audioSource={audioSource} size="small" interactive={false} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minHeight: 36 }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)', letterSpacing: '.02em', color: voice.state === 'error' ? '#f59e0b' : '#c7c7ce' }}>
          {error ? error : STATE_LABEL[voice.state]}
        </span>
        {voice.liveTranscript && voice.state === 'user-speaking' && (
          <span style={{ fontSize: 12.5, color: '#8e8e96', maxWidth: 360, textAlign: 'center', lineHeight: 1.4 }}>
            {voice.liveTranscript}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={voice.toggleMute}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
          title={voice.muted ? 'Unmute' : 'Mute'}
          style={{
            width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 0, borderRadius: '50%', cursor: 'pointer',
            background: voice.muted ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.06)',
            color: voice.muted ? '#f59e0b' : '#c7c7ce',
          }}
        >
          {voice.muted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2M12 19v3" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></svg>
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="End voice session"
          title="End voice"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
            border: 0, borderRadius: 999, cursor: 'pointer',
            background: 'rgba(239,68,68,0.15)', color: '#f87171',
            fontSize: 11.5, fontWeight: 600, fontFamily: 'var(--font-mono)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          End
        </button>
      </div>
      {voice.routingReason && (
        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#52525b' }} title={voice.routingReason}>
          {voice.routingReason.split(';')[0]}
        </span>
      )}
    </div>
  )
}
