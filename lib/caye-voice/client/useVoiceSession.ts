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
    sttRef.current?.cancelSpeech()
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
        if (myEpoch !== epochRef.current || !replyText) return

        dispatch({ type: 'reply_ready' })
        const stt = sttRef.current

        // Preferred path: the OpenAI Realtime WebRTC session that heard the
        // founder also renders the already-authorized Caye reply directly as
        // audio. This avoids browser SpeechSynthesis, removes the robotic OS
        // voice, keeps acoustic echo cancellation in the WebRTC path, and
        // preserves interruption via response.cancel.
        if (stt?.supportsNativeVoice()) {
          await stt.speakReply(replyText)
          if (myEpoch === epochRef.current) dispatch({ type: 'tts_playback_ended' })
          return
        }

        // Degraded/provider fallback: keep the existing cloud/browser TTS
        // pipeline. Browser speech still needs mic suppression because it is
        // external to the realtime peer connection and can feed back into STT.
        const suppressMicDuringPlayback = config.routing.ttsProvider === 'browser'
        if (suppressMicDuringPlayback) stt?.setMuted(true)

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
      setRoutingReason(
        json.sttCredential?.connect?.mode === 'native-voice'
          ? `OpenAI native realtime voice · ${json.sttCredential.connect.model} · ${json.sttCredential.connect.voice}`
          : json.routing?.reason ?? null
      )

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
