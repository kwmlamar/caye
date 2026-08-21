'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { createSttSession, type SttSession } from './stt-connectors'
import { TtsPlaybackController } from './playback'
import { nextVoiceState } from './voice-state-machine'
import type { VoiceSessionConfig, VoiceUiState } from '../types'

export interface UseVoiceSessionArgs {
  workspaceId: string
  /**
   * Sends a finalized voice utterance exactly like a typed message —
   * callers pass CayeDirectThread's own `send()` (pointed at
   * /api/founder/caye-direct/voice/turn) so a spoken turn gets the SAME
   * optimistic bubble / inFlightRuns registration / post-turn refetch a
   * typed one gets, and lands in the SAME thread state. This hook never
   * touches messages or persistence directly — see CayeDirectThread.tsx.
   */
  sendTurn: (text: string, opts: { endpoint: string; sessionId: string }) => Promise<string | null>
  onError?: (message: string) => void
}

export interface VoiceSessionHandle {
  state: VoiceUiState
  liveTranscript: string
  muted: boolean
  micStream: MediaStream | null
  ttsAudioElement: HTMLAudioElement
  routingReason: string | null
  start: () => Promise<void>
  end: () => void
  toggleMute: () => void
}

/**
 * Orchestrates one Caye Direct Live Voice session: mints a session via
 * /voice/session, connects the chosen STT provider directly from the
 * browser, drives the pure state machine off its VAD events, sends each
 * finalized utterance through `sendTurn` (which is really "the normal
 * text send, pointed at the voice endpoint" — see UseVoiceSessionArgs),
 * and streams the reply through TtsPlaybackController with real barge-in:
 * a speech-start event mid-`thinking` or mid-`speaking` stops playback
 * immediately and marks the in-flight turn's eventual reply stale (it
 * still persists to the thread server-side — just isn't spoken, since the
 * founder already moved on to a new utterance).
 */
export function useVoiceSession({ workspaceId, sendTurn, onError }: UseVoiceSessionArgs): VoiceSessionHandle {
  const [state, setState] = useState<VoiceUiState>('idle')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [muted, setMuted] = useState(false)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [routingReason, setRoutingReason] = useState<string | null>(null)

  const sttRef = useRef<SttSession | null>(null)
  const configRef = useRef<VoiceSessionConfig & { sessionId: string } | null>(null)
  const ttsRef = useRef<TtsPlaybackController | null>(null)
  const epochRef = useRef(0)

  if (!ttsRef.current) {
    ttsRef.current = new TtsPlaybackController(async ({ text, provider, workspaceId: ws, sessionId }, signal) => {
      const { session } = await getSession()
      return fetch('/api/founder/caye-direct/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ text, provider, workspaceId: ws, sessionId }),
        signal,
      })
    })
  }

  const dispatch = useCallback((event: Parameters<typeof nextVoiceState>[1]) => {
    setState((current) => nextVoiceState(current, event))
  }, [])

  const bargeIn = useCallback(() => {
    epochRef.current += 1
    ttsRef.current?.stop()
    dispatch({ type: 'user_speech_start' })
  }, [dispatch])

  const handleFinalTranscript = useCallback(
    async (text: string) => {
      const myEpoch = epochRef.current
      setLiveTranscript('')
      dispatch({ type: 'user_speech_end' })
      const config = configRef.current
      if (!config) return
      try {
        const replyText = await sendTurn(text, {
          endpoint: '/api/founder/caye-direct/voice/turn',
          sessionId: config.sessionId,
        })
        if (myEpoch !== epochRef.current) return // superseded by a barge-in — already persisted, just not spoken
        if (!replyText) return
        dispatch({ type: 'reply_ready' })
        ttsRef.current?.onDone(() => {
          if (myEpoch !== epochRef.current) return
          dispatch({ type: 'tts_playback_ended' })
        })
        await ttsRef.current?.speak(replyText, config.routing.ttsProvider, workspaceId, config.sessionId)
      } catch (err) {
        if (myEpoch !== epochRef.current) return
        onError?.(err instanceof Error ? err.message : 'Voice turn failed')
        dispatch({ type: 'error' })
      }
    },
    [dispatch, sendTurn, workspaceId, onError]
  )

  const start = useCallback(async () => {
    dispatch({ type: 'session_started' })
    try {
      const { session } = await getSession()
      const res = await fetch('/api/founder/caye-direct/voice/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not start voice session')
      configRef.current = json
      setRoutingReason(json.routing?.reason ?? null)

      const stt = createSttSession(json.sttCredential)
      sttRef.current = stt
      stt.onPartial((text) => setLiveTranscript(text))
      stt.onFinal((text) => {
        setLiveTranscript(text)
        void handleFinalTranscript(text)
      })
      stt.onSpeechStart(() => bargeIn())
      stt.onSpeechEnd(() => {
        // Only meaningful once we're actually mid-utterance; if the
        // model already moved on (e.g. this is a stray VAD end with no
        // final transcript following), the state machine simply ignores
        // a redundant user_speech_end from a non-user-speaking state.
        dispatch({ type: 'user_speech_end' })
      })
      stt.onError((err) => {
        onError?.(err.message)
        dispatch({ type: 'error' })
      })

      await stt.start()
      setMicStream(stt.getMicStream())
      dispatch({ type: 'connected' })
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Could not start voice session')
      dispatch({ type: 'connect_failed' })
    }
  }, [workspaceId, dispatch, handleFinalTranscript, bargeIn, onError])

  const end = useCallback(() => {
    epochRef.current += 1
    sttRef.current?.stop()
    sttRef.current = null
    ttsRef.current?.stop()
    configRef.current = null
    setMicStream(null)
    setLiveTranscript('')
    dispatch({ type: 'ended' })
  }, [dispatch])

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current
      sttRef.current?.setMuted(next)
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      sttRef.current?.stop()
      ttsRef.current?.stop()
    }
  }, [])

  return {
    state,
    liveTranscript,
    muted,
    micStream,
    ttsAudioElement: ttsRef.current.getAudioElement(),
    routingReason,
    start,
    end,
    toggleMute,
  }
}
