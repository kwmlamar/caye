import { describe, expect, it, vi } from 'vitest'

vi.mock('./voice-note', () => ({
  transcribeWhatsAppVoiceNote: vi.fn(),
}))

import { transcribeWhatsAppVoiceNote } from './voice-note'
import { resolveWhatsAppVoiceInput } from './voice-message'

const mockedTranscribe = vi.mocked(transcribeWhatsAppVoiceNote)

describe('resolveWhatsAppVoiceInput', () => {
  it('returns semantic text while preserving media identity', async () => {
    mockedTranscribe.mockResolvedValue({ transcript: 'What tours are open?', mimeType: 'audio/ogg' })

    await expect(
      resolveWhatsAppVoiceInput(
        { id: 'wa-media-1', mime_type: 'audio/ogg', voice: true },
        'workspace-token'
      )
    ).resolves.toEqual({
      body: 'What tours are open?',
      mediaId: 'wa-media-1',
      mimeType: 'audio/ogg',
    })

    expect(mockedTranscribe).toHaveBeenCalledWith('wa-media-1', 'workspace-token')
  })
})
