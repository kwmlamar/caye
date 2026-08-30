'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { createSttSession, type SttSession } from './stt-connectors'
import { TtsPlaybackController } from './playback'
import { nextVoiceState } from './voice-state-machine'
import type { VoiceSessionConfig, VoiceUiState } from '../types'

export interface UseVoiceSessionArgs {
  workspaceId: string
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
  const mutedRef = useRef(false)

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
        if (myEpoch !== epochRef.current) return
        if (!replyText) return
        dispatch({ type: 'reply_ready' })

        // Browser SpeechSynthesis plays through the same laptop speakers the
        // microphone is listening to. OpenAI Realtime then happily transcribes
        // Caye's own voice as a new founder turn. While browser TTS is active,
        // pause STT input, then restore the founder's explicit mute state after
        // a short acoustic tail. Cloud TTS keeps normal barge-in behavior.
        const suppressMicDuringPlayback = config.routing.ttsProvider === 'browser'
        if (suppressMicDuringPlayback) sttRef.current?.setMuted(true)

        ttsRef.current?.onDone(() => {
          if (myEpoch !== epochRef.current) return
          dispatch({ type: 'tts_playback_ended' })
        })

        try {
          await ttsRef.current?.speak(replyText, config.routing.ttsProvider, workspaceId, config.sessionId)
        } finally {
          if (suppressMicDuringPlayback) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            if (myEpoch === epochRef.current) sttRef.current?.setMuted(mutedRef.current)
          }
        }
      } catch (err) {
        if (myEpoch !== epochRef.current) return
        sttRef.current?.setMuted(mutedRef.current)
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
      stt.onSpeechEnd(() => dispatch({ type: 'user_speech_end' }))
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
      mutedRef.current = next
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
