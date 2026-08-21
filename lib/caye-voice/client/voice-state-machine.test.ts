import { describe, it, expect } from 'vitest'
import { nextVoiceState } from './voice-state-machine'

describe('voice state machine — happy path', () => {
  it('walks idle -> connecting -> listening -> user-speaking -> thinking -> speaking -> listening', () => {
    let state = nextVoiceState('idle', { type: 'session_started' })
    expect(state).toBe('connecting')
    state = nextVoiceState(state, { type: 'connected' })
    expect(state).toBe('listening')
    state = nextVoiceState(state, { type: 'user_speech_start' })
    expect(state).toBe('user-speaking')
    state = nextVoiceState(state, { type: 'user_speech_end' })
    expect(state).toBe('thinking')
    state = nextVoiceState(state, { type: 'reply_ready' })
    expect(state).toBe('speaking')
    state = nextVoiceState(state, { type: 'tts_playback_ended' })
    expect(state).toBe('listening')
  })
})

describe('voice state machine — barge-in (spec item 5, the safety-critical case)', () => {
  it('interrupts speaking immediately on user_speech_start', () => {
    expect(nextVoiceState('speaking', { type: 'user_speech_start' })).toBe('user-speaking')
  })

  it('interrupts thinking on user_speech_start (founder changes their mind before Caye replies)', () => {
    expect(nextVoiceState('thinking', { type: 'user_speech_start' })).toBe('user-speaking')
  })

  it('does not wait for tts_playback_ended before accepting the interruption', () => {
    // i.e. there is no path from `speaking` that requires playback to
    // finish before a new user_speech_start is honored.
    const interrupted = nextVoiceState('speaking', { type: 'user_speech_start' })
    expect(interrupted).not.toBe('speaking')
    expect(interrupted).not.toBe('thinking')
  })

  it('ignores user_speech_start while idle or in error (nothing to interrupt)', () => {
    expect(nextVoiceState('idle', { type: 'user_speech_start' })).toBe('idle')
    expect(nextVoiceState('error', { type: 'user_speech_start' })).toBe('error')
  })
})

describe('voice state machine — lifecycle', () => {
  it('goes to error from any state on error/connect_failed', () => {
    expect(nextVoiceState('listening', { type: 'error' })).toBe('error')
    expect(nextVoiceState('speaking', { type: 'error' })).toBe('error')
    expect(nextVoiceState('connecting', { type: 'connect_failed' })).toBe('error')
  })

  it('always returns to idle on ended, from any state', () => {
    expect(nextVoiceState('speaking', { type: 'ended' })).toBe('idle')
    expect(nextVoiceState('thinking', { type: 'ended' })).toBe('idle')
    expect(nextVoiceState('error', { type: 'ended' })).toBe('idle')
  })

  it('ignores irrelevant events for the current state rather than throwing', () => {
    expect(nextVoiceState('listening', { type: 'reply_ready' })).toBe('listening')
    expect(nextVoiceState('idle', { type: 'connected' })).toBe('idle')
  })
})
