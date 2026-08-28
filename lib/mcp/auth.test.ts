import { afterEach, describe, expect, it } from 'vitest'
import { authenticateMcpFounder } from './auth'

const ORIGINAL_TOKEN = process.env.CAYE_MCP_FOUNDER_TOKEN
const ORIGINAL_USER = process.env.CAYE_MCP_FOUNDER_USER_ID

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CAYE_MCP_FOUNDER_TOKEN
  else process.env.CAYE_MCP_FOUNDER_TOKEN = ORIGINAL_TOKEN
  if (ORIGINAL_USER === undefined) delete process.env.CAYE_MCP_FOUNDER_USER_ID
  else process.env.CAYE_MCP_FOUNDER_USER_ID = ORIGINAL_USER
})

describe('MCP founder authentication', () => {
  it('fails closed when server configuration is missing', () => {
    delete process.env.CAYE_MCP_FOUNDER_TOKEN
    delete process.env.CAYE_MCP_FOUNDER_USER_ID
    expect(authenticateMcpFounder('Bearer anything')).toBeNull()
  })

  it('rejects missing and incorrect bearer tokens', () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = 'correct-secret'
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    expect(authenticateMcpFounder(null)).toBeNull()
    expect(authenticateMcpFounder('Bearer wrong-secret')).toBeNull()
  })

  it('maps valid server auth to the configured founder identity only', () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = 'correct-secret'
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    expect(authenticateMcpFounder('Bearer correct-secret')).toEqual({ founderUserId: 'founder-user-id' })
  })
})
