import { describe, expect, it } from 'vitest'
import { founderRunLabel } from './caye-direct-runs'

describe('founderRunLabel', () => {
  it('makes control requests explicit at the safe boundary', () => {
    expect(founderRunLabel({ status: 'running', stage_label: 'Researching…', control_requested: 'pause' })).toContain('pausing')
    expect(founderRunLabel({ status: 'running', stage_label: 'Researching…', control_requested: 'cancel' })).toContain('stopping')
  })
  it('uses founder-oriented waiting language', () => {
    expect(founderRunLabel({ status: 'waiting_user', stage_label: null, control_requested: null })).toBe('Needs you')
  })
  it('keeps semantic progress copy', () => {
    expect(founderRunLabel({ status: 'running', stage_label: 'Comparing pricing and positioning…', control_requested: null })).toBe('Comparing pricing and positioning…')
  })
})
