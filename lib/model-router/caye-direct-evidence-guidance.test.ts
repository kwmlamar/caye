import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { FOUNDER_DIRECT_EVIDENCE_GUIDANCE } from './caye-direct-evidence-guidance'

describe('Caye Direct evidence synthesis contract', () => {
  it('forbids widening held-queue evidence into global attention claims', () => {
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('get_held_queue covers held customer threads only')
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('no held customer threads')
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('nothing is pending')
  })

  it('keeps failed and partial reads visible as evidence gaps', () => {
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toMatch(/failed, unavailable, permission-denied, stale, partial, or timed-out tool/)
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('does not prove the requested state is empty')
  })

  it('requires broad requests to cover material scopes and preserves workspace boundaries', () => {
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('broad multi-system questions')
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('enough independent read tools')
    expect(FOUNDER_DIRECT_EVIDENCE_GUIDANCE).toContain('Workspace scope is part of the evidence')
  })
})
