import type { VoiceUiState } from '../types'

/**
 * Pure state machine for the voice session UI (spec items 6/13/14).
 * Deliberately separated from useVoiceSession.ts's browser-API-heavy
 * orchestration so barge-in behavior — the single most safety-critical
 * interaction in this feature — can be unit tested with zero mocking of
 * WebRTC/MediaSource/MediaStream (see voice-state-machine.test.ts).
 *
 * The one rule every transition table below exists to enforce: a
 * `user_speech_start` event ALWAYS wins, from every state that has audio
 * playing or could soon have audio playing (`thinking`, `speaking`). This
 * is what "Do not wait for the full generated audio to finish" (spec item
 * 5) means at the state-machine level — interruption is not something
 * `listening` alone handles, it preempts `speaking`/`thinking` too.
 */
export type VoiceEvent =
  | { type: 'session_started' }
  | { type: 'connected' }
  | { type: 'connect_failed' }
  | { type: 'user_speech_start' }
  | { type: 'user_speech_end' }
  | { type: 'reply_ready' }
  | { type: 'tts_playback_ended' }
  | { type: 'error' }
  | { type: 'ended' }

export function nextVoiceState(current: VoiceUiState, event: VoiceEvent): VoiceUiState {
  if (event.type === 'ended') return 'idle'
  if (event.type === 'error' || event.type === 'connect_failed') return 'error'

  // Barge-in: unconditional from any state where Caye might be mid-thought
  // or mid-speech. A new user utterance always takes priority.
  if (event.type === 'user_speech_start') {
    if (current === 'idle' || current === 'error') return current
    return 'user-speaking'
  }

  switch (current) {
    case 'idle':
      return event.type === 'session_started' ? 'connecting' : current
    case 'connecting':
      return event.type === 'connected' ? 'listening' : current
    case 'listening':
      // user_speech_start handled above.
      return current
    case 'user-speaking':
      return event.type === 'user_speech_end' ? 'thinking' : current
    case 'thinking':
      return event.type === 'reply_ready' ? 'speaking' : current
    case 'speaking':
      return event.type === 'tts_playback_ended' ? 'listening' : current
    case 'error':
      return current
    default:
      return current
  }
}
