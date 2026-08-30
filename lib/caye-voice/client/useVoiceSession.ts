'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { createSttSession, type SttSession } from './stt-connectors'
import { TtsPlaybackController } from './playback'
import { nextVoiceState } from './voice-state-machine'
import { VoiceTurnTimeline } from './voice-timeline'
import type { VoiceSessionConfig, VoiceUiState } from '../types'

/**
 * How long Caye will stay silent after the founder stops speaking before
 * saying something short to acknowledge the turn.
 *
 * A conversational turn resolves well inside this, so the founder never
 * hears a preamble on "hey" — it exists for the turns that go to the
 * control plane and run tools, where the alternative is ten to thirty
 * seconds of nothing and no way to tell a working Caye from a broken one.
 * Tuned to sit just above a healthy tool-free round trip so it fires when
 * the turn is genuinely slow, not merely normal.
 */
const PREAMBLE_AFTER_MS = Number(process.env.NEXT_PUBLIC_CAYE_VOICE_PREAMBLE_MS ?? '900')

/**
 * Fixed, factless acknowledgements. Deliberately a hardcoded list rather
 * than model-generated: this is spoken BEFORE Caye knows anything, so it
 * must be incapable of asserting a result. Nothing here states an outcome,
 * a number, or a completed action.
 */
const PREAMBLES = ['Checking now.', 'One sec, looking.', 'Let me check.'] as const

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
  const timelineRef = useRef<VoiceTurnTimeline>(new VoiceTurnTimeline())
  const preambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPreambleTimer = useCallback(() => {
    if (preambleTimerRef.current) {
      clearTimeout(preambleTimerRef.current)
      preambleTimerRef.current = null
    }
  }, [])

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
    clearPreambleTimer()
    timelineRef.current.record('barge_in')
    sttRef.current?.cancelSpeech()
    ttsRef.current?.stop()
    dispatch({ type: 'user_speech_start' })
    // A new utterance starts a new turn's clock. Done after cancelling the
    // old one so the barge_in mark lands on the turn being interrupted.
    timelineRef.current.begin()
  }, [dispatch, clearPreambleTimer])

  const handleFinalTranscript = useCallback(
    async (text: string) => {
      const myEpoch = epochRef.current
      const timeline = timelineRef.current
      timeline.record('transcript_final')
      setLiveTranscript('')
      dispatch({ type: 'user_speech_end' })
      const config = configRef.current
      if (!config) return

      try {
        // Arm the acknowledgement before the request, not after: the point
        // is to cover a slow turn, and by the time a slow turn answers it
        // is far too late to decide to say something. Cancelled the moment
        // a reply lands, so a fast turn never speaks it.
        const stt = sttRef.current
        if (stt?.supportsNativeVoice()) {
          clearPreambleTimer()
          preambleTimerRef.current = setTimeout(() => {
            preambleTimerRef.current = null
            if (myEpoch !== epochRef.current) return
            const line = PREAMBLES[Math.floor(Math.random() * PREAMBLES.length)]
            timeline.record('preamble_spoken')
            // Not awaited: this is a courtesy noise running alongside the
            // real turn, and the real reply's speakReply() cancels it.
            void stt.speakReply(line).catch(() => {})
          }, PREAMBLE_AFTER_MS)
        }

        timeline.record('request_start')
        const replyText = await sendTurn(text, {
          endpoint: '/api/founder/caye-direct/voice/turn',
          sessionId: config.sessionId,
        })
        timeline.record('request_end')
        clearPreambleTimer()
        if (myEpoch !== epochRef.current || !replyText) {
          timeline.flush({ workspaceId, sessionId: config.sessionId })
          return
        }

        dispatch({ type: 'reply_ready' })
        timeline.record('playback_requested')

        // Preferred path: the OpenAI Realtime WebRTC session that heard the
        // founder also renders the already-authorized Caye reply directly as
        // audio. This avoids browser SpeechSynthesis, removes the robotic OS
        // voice, keeps acoustic echo cancellation in the WebRTC path, and
        // preserves interruption via response.cancel.
        if (stt?.supportsNativeVoice()) {
          await stt.speakReply(replyText)
          timeline.record('playback_ended')
          timeline.flush({ workspaceId, sessionId: config.sessionId })
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
          timeline.record('playback_ended')
          timeline.flush({ workspaceId, sessionId: config.sessionId })
        } finally {
          if (suppressMicDuringPlayback) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            if (myEpoch === epochRef.current) sttRef.current?.setMuted(mutedRef.current)
          }
        }
      } catch (err) {
        clearPreambleTimer()
        timeline.flush({ workspaceId, sessionId: config.sessionId })
        if (myEpoch !== epochRef.current) return
        sttRef.current?.setMuted(mutedRef.current)
        onError?.(err instanceof Error ? err.message : 'Voice turn failed')
        dispatch({ type: 'error' })
      }
    },
    [dispatch, sendTurn, workspaceId, onError, clearPreambleTimer]
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
      stt.onPartial((text) => {
        timelineRef.current.record('transcript_partial_first')
        setLiveTranscript(text)
      })
      stt.onFinal((text) => {
        setLiveTranscript(text)
        void handleFinalTranscript(text)
      })
      stt.onSpeechStart(() => bargeIn())
      stt.onSpeechEnd(() => {
        timelineRef.current.record('speech_end')
        dispatch({ type: 'user_speech_end' })
      })
      stt.onSpeechAudioStart(() => timelineRef.current.record('first_audible_audio'))
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
    clearPreambleTimer()
    sttRef.current?.stop()
    sttRef.current = null
    ttsRef.current?.stop()
    configRef.current = null
    setMicStream(null)
    setLiveTranscript('')
    dispatch({ type: 'ended' })
  }, [dispatch, clearPreambleTimer])

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current
      mutedRef.current = next
      sttRef.current?.setMuted(next)
      return next
    })
  }, [])

  useEffect(() => {
    const clearTimer = clearPreambleTimer
    return () => {
      clearTimer()
      sttRef.current?.stop()
      ttsRef.current?.stop()
    }
  }, [clearPreambleTimer])

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
