import { describe, expect, it } from 'vitest'
import { computeCanonicalKey } from './dedupe'

describe('computeCanonicalKey — cross-source dedup (#192)', () => {
  it('collapses the same posting seen from two different sources into one canonical key', () => {
    const fromGreenhouse = computeCanonicalKey({
      company: 'Example Co',
      title: 'Software Engineer I',
      location: 'Remote - US',
      requisitionId: null,
    })
    const fromLever = computeCanonicalKey({
      company: 'Example Co.',
      title: 'Software Engineer I',
      location: 'Remote — US',
      requisitionId: null,
    })
    expect(fromGreenhouse).toBe(fromLever)
  })

  it('prefers requisition id as the strongest identity signal, converging over a reworded title', () => {
    const first = computeCanonicalKey({
      company: 'Example Co',
      title: 'Software Engineer I',
      location: 'Austin, TX',
      requisitionId: 'REQ-4821',
    })
    const second = computeCanonicalKey({
      company: 'Example Co',
      title: 'Software Engineer, Backend',
      location: 'Austin, TX (Hybrid)',
      requisitionId: 'REQ-4821',
    })
    expect(first).toBe(second)
  })

  it('normalizes seniority tokens in the title so equivalent postings converge', () => {
    const withSeniorPrefix = computeCanonicalKey({
      company: 'Example Co',
      title: 'Sr. Software Engineer II',
      location: 'New York, NY',
      requisitionId: null,
    })
    const plain = computeCanonicalKey({
      company: 'Example Co',
      title: 'Software Engineer',
      location: 'New York, NY',
      requisitionId: null,
    })
    expect(withSeniorPrefix).toBe(plain)
  })

  it('produces different keys for genuinely different companies', () => {
    const a = computeCanonicalKey({ company: 'Example Co', title: 'Software Engineer', location: 'Remote', requisitionId: null })
    const b = computeCanonicalKey({ company: 'Other Co', title: 'Software Engineer', location: 'Remote', requisitionId: null })
    expect(a).not.toBe(b)
  })
})
