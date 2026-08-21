import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { isLocalBridgeEnvironment } from './local-bridge'

const ORIGINAL_VERCEL = process.env.VERCEL
const ORIGINAL_BRIDGE_FLAG = process.env.CAYE_DIRECT_LOCAL_BRIDGE

describe('isLocalBridgeEnvironment', () => {
  afterEach(() => {
    if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL
    else process.env.VERCEL = ORIGINAL_VERCEL
    if (ORIGINAL_BRIDGE_FLAG === undefined) delete process.env.CAYE_DIRECT_LOCAL_BRIDGE
    else process.env.CAYE_DIRECT_LOCAL_BRIDGE = ORIGINAL_BRIDGE_FLAG
  })

  it('is false on Vercel even if the bridge flag is set — the deployed app must never think it has a bridge', () => {
    process.env.VERCEL = '1'
    process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'
    expect(isLocalBridgeEnvironment()).toBe(false)
  })

  it('is false by default outside Vercel (opt-in, not opt-out)', () => {
    delete process.env.VERCEL
    delete process.env.CAYE_DIRECT_LOCAL_BRIDGE
    expect(isLocalBridgeEnvironment()).toBe(false)
  })

  it('is true only outside Vercel with the bridge flag explicitly set', () => {
    delete process.env.VERCEL
    process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'
    expect(isLocalBridgeEnvironment()).toBe(true)
  })
})
