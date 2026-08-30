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

  it('turns verified inbound audio into semantic text while preserving media identity', async () => {
    transcribe.mockResolvedValue({ transcript: 'What is on my schedule?', mimeType: 'audio/ogg' })

    await expect(
      resolveVerifiedOperatorVoiceInput(
        {
          id: 'wamid.audio',
          type: 'audio',
          audio: { id: 'media-123', mime_type: 'audio/ogg; codecs=opus', voice: true },
        },
        'platform-token'
      )
    ).resolves.toEqual({
      body: 'What is on my schedule?',
      inboundWasVoice: true,
      mediaId: 'media-123',
      mimeType: 'audio/ogg',
      voice: true,
    })
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledWith('media-123', 'platform-token')
  })

  it('does not reinterpret unsupported media as text', async () => {
    await expect(
      resolveVerifiedOperatorVoiceInput(
        { id: 'wamid.image', type: 'image' },
        'platform-token'
      )
    ).resolves.toBeNull()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('sends only the already-authorized reply text as voice', async () => {
    sendVoice.mockResolvedValue(undefined)
    await sendVerifiedOperatorVoiceReply({
      to: '+12425550123',
      text: 'You have two bookings tomorrow.',
      phoneNumberId: 'platform-phone-id',
      accessToken: 'platform-token',
    })
    expect(sendVoice).toHaveBeenCalledTimes(1)
    expect(sendVoice).toHaveBeenCalledWith(
      '+12425550123',
      'You have two bookings tomorrow.',
      'platform-phone-id',
      'platform-token'
    )
  })
})
