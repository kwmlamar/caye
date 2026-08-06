import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

process.env.CONNECT_LINK_SECRET = 'test-secret'
process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'

/**
 * Minimal stand-in for the two supabase chains this tool uses:
 *   from('workspace_ai_config').select().eq().maybeSingle()
 *   from('connected_accounts').select().eq().eq()   -> awaited directly
 */
let intake: unknown = null
let activeTypes: string[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { channel_intake: intake } }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: activeTypes.map((t) => ({ channel_type: t })) }),
      }
      // connected_accounts is awaited without maybeSingle; workspace_ai_config
      // always terminates in maybeSingle. One shape serves both.
      void table
      return chain
    },
  }),
}))

const { getConnectLink } = await import('./get-connect-link')

const ctx = { workspaceId: 'ws-1', role: 'owner' } as unknown as ToolContext

function setup(opts: { intake?: unknown; connected?: string[] }) {
  intake = opts.intake ?? null
  activeTypes = opts.connected ?? []
}

describe('get_connect_link — WhatsApp gate', () => {
  it('refuses WhatsApp when the owner is on a personal phone', async () => {
    setup({ intake: { whatsappLine: 'personal' } })
    const res = await getConnectLink.execute({ channel: 'whatsapp' }, ctx)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ blocked: 'personal_phone' })
    expect(res.data).not.toHaveProperty('url')
  })

  it('refuses WhatsApp before the line question has been asked', async () => {
    setup({ intake: {} })
    const res = await getConnectLink.execute({ channel: 'whatsapp' }, ctx)
    expect(res.data).toMatchObject({ blocked: 'unknown_line' })
    expect(res.data).not.toHaveProperty('url')
  })

  it('refuses WhatsApp when they said guests do not use it', async () => {
    setup({ intake: { inventory: { whatsapp: false }, whatsappLine: 'business' } })
    const res = await getConnectLink.execute({ channel: 'whatsapp' }, ctx)
    expect(res.data).toMatchObject({ blocked: 'not_used' })
  })

  it('issues a link for a confirmed business line', async () => {
    setup({ intake: { whatsappLine: 'business' } })
    const res = await getConnectLink.execute({ channel: 'whatsapp' }, ctx)
    expect(res.data).toMatchObject({ channel: 'whatsapp' })
    expect(String((res.data as { url: string }).url)).toContain('/connect?only=whatsapp&t=')
  })

  it('issues a link for a landline — voice verification loses nothing', async () => {
    setup({ intake: { whatsappLine: 'landline' } })
    const res = await getConnectLink.execute({ channel: 'whatsapp' }, ctx)
    expect((res.data as { url?: string }).url).toBeTruthy()
  })
})

describe('get_connect_link — email provider resolution', () => {
  it('routes Google domains to the Gmail initiator', async () => {
    setup({ intake: { emailProvider: 'google' } })
    const res = await getConnectLink.execute({ channel: 'email' }, ctx)
    expect(res.data).toMatchObject({ channel: 'gmail' })
    expect(String((res.data as { url: string }).url)).toContain('/api/auth/gmail?t=')
  })

  it('asks rather than guessing when the provider is unknown', async () => {
    setup({ intake: {} })
    const res = await getConnectLink.execute({ channel: 'email' }, ctx)
    expect(res.data).toMatchObject({ blocked: 'provider_unknown' })
  })

  it('does not re-offer an inbox that is already connected via Zoho', async () => {
    // The Bimini shape: channel_type 'email', never 'gmail'.
    setup({ intake: { emailProvider: 'google' }, connected: ['email'] })
    const res = await getConnectLink.execute({ channel: 'email' }, ctx)
    expect(res.data).toMatchObject({ blocked: 'already_connected' })
  })
})
