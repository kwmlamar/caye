import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
process.env.CONNECT_LINK_SECRET = 'test-secret'
process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'

const { decideNextAction, composeProgressMessage } = await import('./connect-progress')
const { deriveChannelState } = await import('./slots')

const WS = 'ws-1'

describe('decideNextAction', () => {
  it('offers WhatsApp once the line is confirmed as a business one', () => {
    const state = deriveChannelState(['gmail'], { whatsappLine: 'business' })
    const next = decideNextAction(WS, state, { whatsappLine: 'business' })
    expect(next).toMatchObject({ kind: 'offer', label: 'WhatsApp' })
  })

  it('asks the line question instead of skipping WhatsApp silently', () => {
    // The four-month Bimini failure: WhatsApp sat unconnected and nobody
    // ever asked why. Unknown must produce a question, not silence.
    const intake = { emailProvider: 'google' as const }
    const state = deriveChannelState(['gmail'], intake)
    expect(decideNextAction(WS, state, intake)).toEqual({ kind: 'ask_whatsapp_line' })
  })

  it('asks about social rather than firing a link they may not need', () => {
    const intake = { whatsappLine: 'personal' as const }
    const state = deriveChannelState(['gmail'], intake)
    expect(decideNextAction(WS, state, intake)).toEqual({ kind: 'ask_social' })
  })

  it('offers Instagram once they confirm guests use it', () => {
    const intake = { whatsappLine: 'personal' as const, inventory: { instagram: true } }
    const state = deriveChannelState(['gmail'], intake)
    expect(decideNextAction(WS, state, intake)).toMatchObject({ kind: 'offer', label: 'Instagram' })
  })

  it('finishes without pushing WhatsApp at a personal-phone owner', () => {
    const intake = {
      whatsappLine: 'personal' as const,
      inventory: { instagram: false, messenger: false },
    }
    const state = deriveChannelState(['gmail'], intake)
    expect(decideNextAction(WS, state, intake)).toEqual({
      kind: 'done',
      whatsappOnPersonalPhone: true,
    })
  })

  it('asks for the email host rather than guessing when detection failed', () => {
    // emailProvider null => no inbox link can be built, so it must not
    // silently jump past the inbox to another channel.
    const intake = { emailProvider: null, whatsappLine: 'business' as const }
    const state = deriveChannelState([], intake)
    expect(decideNextAction(WS, state, intake)).toMatchObject({ kind: 'offer', label: 'WhatsApp' })
  })
})

describe('composeProgressMessage', () => {
  it('celebrates only on the first connection', () => {
    const first = composeProgressMessage({
      justConnected: 'inbox',
      isFirstConnection: true,
      businessName: 'Bimini Island Tours',
      next: { kind: 'done', whatsappOnPersonalPhone: false },
    })
    expect(first).toContain('🎉')
    expect(first).toContain('Bimini Island Tours')

    const later = composeProgressMessage({
      justConnected: 'instagram',
      isFirstConnection: false,
      businessName: 'Bimini Island Tours',
      next: { kind: 'done', whatsappOnPersonalPhone: false },
    })
    expect(later).not.toContain('🎉')
  })

  it('reassures that declining WhatsApp does not mean losing Caye', () => {
    const msg = composeProgressMessage({
      justConnected: 'inbox',
      isFirstConnection: true,
      businessName: null,
      next: { kind: 'done', whatsappOnPersonalPhone: true },
    })
    expect(msg).toMatch(/reach me right here/i)
  })

  it('carries the link when offering the next channel', () => {
    const msg = composeProgressMessage({
      justConnected: 'inbox',
      isFirstConnection: true,
      businessName: null,
      next: { kind: 'offer', label: 'Instagram', url: 'https://example.test/x' },
    })
    expect(msg).toContain('https://example.test/x')
  })
})
