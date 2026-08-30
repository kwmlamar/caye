import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./voice-note', () => ({
  transcribeWhatsAppVoiceNote: vi.fn(),
  sendWhatsAppVoiceNote: vi.fn(),
}))

import { transcribeWhatsAppVoiceNote, sendWhatsAppVoiceNote } from './voice-note'
import {
  resolveVerifiedOperatorVoiceInput,
  sendVerifiedOperatorVoiceReply,
} from './operator-voice'

const transcribe = vi.mocked(transcribeWhatsAppVoiceNote)
const sendVoice = vi.mocked(sendWhatsAppVoiceNote)

describe('operator WhatsApp voice adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes ordinary text through without touching voice services', async () => {
    await expect(
      resolveVerifiedOperatorVoiceInput(
        { id: 'wamid.text', type: 'text', text: { body: '  check bookings  ' } },
        'platform-token'
      )
    ).resolves.toEqual({ body: 'check bookings', inboundWasVoice: false })
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('turns verified inbound audio into trimmed semantic text while preserving media identity', async () => {
    transcribe.mockResolvedValue({ transcript: '  What is on my schedule?  ', mimeType: 'audio/ogg' })
    await expect(resolveVerifiedOperatorVoiceInput({ id: 'wamid.audio', type: 'audio', audio: { id: 'media-123', mime_type: 'audio/ogg; codecs=opus', voice: true } }, 'platform-token')).resolves.toEqual({ body: 'What is on my schedule?', inboundWasVoice: true, mediaId: 'media-123', mimeType: 'audio/ogg', voice: true })
  })

  it('does not turn an empty transcription into an operator turn', async () => {
    transcribe.mockResolvedValue({ transcript: '   ', mimeType: 'audio/ogg' })
    await expect(resolveVerifiedOperatorVoiceInput({ id: 'wamid.audio', type: 'audio', audio: { id: 'media-empty', voice: true } }, 'platform-token')).resolves.toBeNull()
  })

  it('rejects an unbounded transcription before the operator agent', async () => {
    transcribe.mockResolvedValue({ transcript: 'x'.repeat(12_001), mimeType: 'audio/ogg' })
    await expect(resolveVerifiedOperatorVoiceInput({ id: 'wamid.audio', type: 'audio', audio: { id: 'media-huge', voice: true } }, 'platform-token')).rejects.toThrow('operator_voice_transcript_too_large')
  })

  it('does not reinterpret unsupported media as text', async () => {
    await expect(resolveVerifiedOperatorVoiceInput({ id: 'wamid.image', type: 'image' }, 'platform-token')).resolves.toBeNull()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('sends only the already-authorized trimmed reply text as voice', async () => {
    sendVoice.mockResolvedValue(undefined)
    await sendVerifiedOperatorVoiceReply({ to: '+12425550123', text: '  You have two bookings tomorrow.  ', phoneNumberId: 'platform-phone-id', accessToken: 'platform-token' })
    expect(sendVoice).toHaveBeenCalledWith('+12425550123', 'You have two bookings tomorrow.', 'platform-phone-id', 'platform-token')
  })

  it('refuses to synthesize an empty operator reply', async () => {
    await expect(sendVerifiedOperatorVoiceReply({ to: '+12425550123', text: '   ', phoneNumberId: 'platform-phone-id', accessToken: 'platform-token' })).rejects.toThrow('operator_voice_reply_empty')
    expect(sendVoice).not.toHaveBeenCalled()
  })
})
