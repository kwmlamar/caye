import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./media', () => ({
  downloadWhatsAppMediaWithToken: vi.fn(),
}))

import { downloadWhatsAppMediaWithToken } from './media'
import { transcribeWhatsAppVoiceNote } from './voice-note'

const mockedDownload = vi.mocked(downloadWhatsAppMediaWithToken)

describe('WhatsApp voice notes', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    mockedDownload.mockResolvedValue({
      base64: Buffer.from('voice-bytes').toString('base64'),
      mimeType: 'audio/ogg',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.OPENAI_API_KEY
  })

  it('transcribes downloaded WhatsApp audio with the configured token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'Book me for tomorrow' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const result = await transcribeWhatsAppVoiceNote('media-1', 'workspace-token')

    expect(mockedDownload).toHaveBeenCalledWith('media-1', 'workspace-token')
    expect(result).toEqual({ transcript: 'Book me for tomorrow', mimeType: 'audio/ogg' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an empty transcript', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: '   ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await expect(transcribeWhatsAppVoiceNote('media-2', 'workspace-token')).rejects.toThrow(
      'empty voice-note transcript'
    )
  })
})
