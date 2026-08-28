import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ isFounderUserId: vi.fn((value: string) => value === 'founder-user-id') }))
vi.mock('@/lib/founder', () => ({ isFounderUserId: mocks.isFounderUserId }))

import { authenticateMcpFounder } from './auth'

const ORIGINAL_TOKEN = process.env.CAYE_MCP_FOUNDER_TOKEN
const ORIGINAL_USER = process.env.CAYE_MCP_FOUNDER_USER_ID
const TOKEN = 'correct-secret-that-is-definitely-long-enough'

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CAYE_MCP_FOUNDER_TOKEN
  else process.env.CAYE_MCP_FOUNDER_TOKEN = ORIGINAL_TOKEN
  if (ORIGINAL_USER === undefined) delete process.env.CAYE_MCP_FOUNDER_USER_ID
  else process.env.CAYE_MCP_FOUNDER_USER_ID = ORIGINAL_USER
  vi.clearAllMocks()
})

describe('MCP founder authentication', () => {
  it('fails closed when server configuration is missing', () => {
    delete process.env.CAYE_MCP_FOUNDER_TOKEN
    delete process.env.CAYE_MCP_FOUNDER_USER_ID
    expect(authenticateMcpFounder('Bearer anything')).toBeNull()
  })

  it('fails closed on weak tokens and non-founder configured identities', () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = 'too-short'
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    expect(authenticateMcpFounder('Bearer too-short')).toBeNull()

    process.env.CAYE_MCP_FOUNDER_TOKEN = TOKEN
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'not-a-founder'
    expect(authenticateMcpFounder(`Bearer ${TOKEN}`)).toBeNull()
  })

  it('rejects missing and incorrect bearer tokens', () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = TOKEN
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    expect(authenticateMcpFounder(null)).toBeNull()
    expect(authenticateMcpFounder('Bearer wrong-secret-that-is-also-long-enough')).toBeNull()
  })

  it('maps valid server auth to a configured founder identity only', () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = TOKEN
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    expect(authenticateMcpFounder(`Bearer ${TOKEN}`)).toEqual({ founderUserId: 'founder-user-id' })
    expect(mocks.isFounderUserId).toHaveBeenCalledWith('founder-user-id')
  })
})
