import { describe, expect, it } from 'vitest'
import { codingSessionBranch, evaluateEngineeringClosure } from './closure-policy'

const base = {
  repository: 'kwmlamar/caye',
  baseBranch: 'main',
  workBranch: 'caye/coding-session/11111111-1111-4111-8111-111111111111',
  testPassed: true,
  buildPassed: true,
  branchPushPassed: true,
  productionObserved: false,
}

describe('engineering coding-session closure', () => {
  it('records passing branch evidence without claiming production success', () => {
    expect(evaluateEngineeringClosure(base)).toMatchObject({
      verdict: 'branch_verified',
      comparison: 'confirmed',
      environment: 'branch',
      productionVerified: false,
    })
  })

  it('fails closed for the wrong repository', () => {
    expect(evaluateEngineeringClosure({ ...base, repository: 'attacker/repo' })).toMatchObject({
      verdict: 'failed', comparison: 'contradicted', productionVerified: false,
    })
  })

  it('refuses execution on main', () => {
    expect(evaluateEngineeringClosure({ ...base, workBranch: 'main' })).toMatchObject({
      verdict: 'failed', comparison: 'contradicted', productionVerified: false,
    })
  })

  it('does not call incomplete branch evidence successful', () => {
    expect(evaluateEngineeringClosure({ ...base, buildPassed: null })).toMatchObject({
      verdict: 'inconclusive', comparison: 'inconclusive', productionVerified: false,
    })
  })

  it('requires a healthy production observation for production verification', () => {
    expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: true })).toMatchObject({
      verdict: 'production_verified', environment: 'production', productionVerified: true,
    })
    expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: false })).toMatchObject({
      verdict: 'failed', comparison: 'contradicted', environment: 'production', productionVerified: false,
    })
  })

  it('derives only isolated branches from valid session ids', () => {
    expect(codingSessionBranch('11111111-1111-4111-8111-111111111111')).toBe('caye/coding-session/11111111-1111-4111-8111-111111111111')
    expect(() => codingSessionBranch('main')).toThrow('Invalid coding session id')
  })
})
