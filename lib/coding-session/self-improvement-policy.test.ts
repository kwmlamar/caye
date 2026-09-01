import { describe, expect, it } from 'vitest'

import {
  autonomousMergeAllowedForSelfImprovement,
  classifySelfImprovementChange,
  isProtectedSelfImprovementPath,
  isRecognizedTestFile,
} from './self-improvement-policy'

describe('bounded self-improvement risk policy', () => {
  it('recognizes repository test conventions', () => {
    expect(isRecognizedTestFile('tests/foo.ts')).toBe(true)
    expect(isRecognizedTestFile('lib/foo.test.ts')).toBe(true)
    expect(isRecognizedTestFile('app/__tests__/foo.spec.tsx')).toBe(true)
  })

  it('allows only unprotected test-only changes', () => {
    expect(classifySelfImprovementChange({ changedPaths: ['lib/foo.test.ts'] })).toMatchObject({
      riskClass: 'test_only', autonomouslyEligible: true, founderRequired: false,
    })
  })

  it('does not trust model-supplied safe classification', () => {
    expect(classifySelfImprovementChange({ changedPaths: ['lib/foo.ts'], modelRisk: 'safe', modelCategory: 'test_only' })).toMatchObject({
      riskClass: 'unsupported', autonomouslyEligible: false,
    })
  })

  it('requires founder approval for protected areas even when the file is a test', () => {
    expect(classifySelfImprovementChange({ changedPaths: ['lib/auth/session.test.ts'] })).toMatchObject({
      riskClass: 'founder_required', founderRequired: true, protectedArea: true,
    })
    expect(classifySelfImprovementChange({ changedPaths: ['supabase/migrations/20260901_test.sql'] }).founderRequired).toBe(true)
    expect(classifySelfImprovementChange({ changedPaths: ['lib/decision-authority.test.ts'] }).founderRequired).toBe(true)
  })

  it('protects the protection layer and approval/security boundaries', () => {
    for (const path of [
      'lib/coding-session/self-improvement-policy.test.ts',
      'lib/coding-session/recommendation-start.test.ts',
      'lib/approval-bypass.test.ts',
      'lib/security-boundary.test.ts',
    ]) expect(isProtectedSelfImprovementPath(path)).toBe(true)
  })

  it('does not authorize autonomous merge in v1', () => {
    expect(autonomousMergeAllowedForSelfImprovement()).toBe(false)
  })
})
