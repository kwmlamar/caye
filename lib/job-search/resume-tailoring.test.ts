import { describe, expect, it } from 'vitest'
import { emphasizeSkills, generateCoverNote, tailorResume } from './resume-tailoring'

describe('emphasizeSkills — truthful tailoring (#192)', () => {
  it('never introduces a skill absent from the source pool', () => {
    const pool = ['TypeScript', 'React', 'PostgreSQL']
    const jobSkills = ['TypeScript', 'Kubernetes', 'Go'] // Kubernetes/Go not in founder's verified pool
    const result = emphasizeSkills(pool, jobSkills)
    for (const skill of result) {
      expect(pool).toContain(skill)
    }
    expect(result).not.toContain('Kubernetes')
    expect(result).not.toContain('Go')
  })

  it('orders overlapping skills first, matching the job posting order', () => {
    const pool = ['PostgreSQL', 'React', 'TypeScript']
    const jobSkills = ['TypeScript', 'React']
    const result = emphasizeSkills(pool, jobSkills)
    expect(result.slice(0, 2)).toEqual(['React', 'TypeScript'])
  })

  it('returns the full pool, reordered, even with no job-skill overlap', () => {
    const pool = ['TypeScript', 'React']
    const result = emphasizeSkills(pool, ['Rust'])
    expect(result.sort()).toEqual(['React', 'TypeScript'])
  })
})

describe('tailorResume — no unsupported claims', () => {
  const variant = {
    variantKey: 'full_stack' as const,
    title: 'Software Engineer / Full Stack',
    summary: 'Recent CS graduate with hands-on project experience.',
    sections: {},
    status: 'verified' as const,
  }
  const profile = { skills: ['TypeScript', 'React', 'Node.js'], summary: 'Recent CS graduate.' }

  it('every emphasized skill traces back to the verified profile skill pool', () => {
    const result = tailorResume(variant, profile, ['TypeScript', 'Django', 'AWS'])
    for (const skill of result.emphasizedSkills) {
      expect(profile.skills).toContain(skill)
    }
    expect(result.content).not.toMatch(/Django/i)
    expect(result.content).not.toMatch(/AWS/i)
  })

  it('the tailored content includes only the verbatim base summary plus verified skills', () => {
    const result = tailorResume(variant, profile, ['React'])
    expect(result.content).toContain(variant.summary)
    expect(result.content).toContain('React')
  })
})

describe('generateCoverNote — traceable to emphasized skills only', () => {
  it('never mentions a skill outside the emphasized list', () => {
    const note = generateCoverNote({
      companyName: 'Example Co',
      roleTitle: 'Software Engineer I',
      emphasizedSkills: ['TypeScript', 'React'],
      summary: 'Recent CS graduate with hands-on project experience.',
    })
    expect(note).toContain('TypeScript')
    expect(note).not.toMatch(/kubernetes/i)
  })
})
