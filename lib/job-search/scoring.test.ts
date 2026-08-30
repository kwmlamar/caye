import { describe, expect, it } from 'vitest'
import { scoreCandidate, type ScoringInput } from './scoring'

const baseSignals = { optExcluded:false, citizenshipRequired:false, clearanceRequired:false, ambiguousEligibilityLanguage:false, evidence:[] as string[] }
const strongFitBase: ScoringInput = {
  title:'Software Engineer I', targetTitles:['Software Engineer I','Junior Software Engineer'], candidateSkills:['TypeScript','React','Node.js'], founderSkills:['TypeScript','React','Node.js','PostgreSQL'], requiresDegree:'preferred', founderHasDegree:true, minYearsExperienceRequired:1, founderYearsExperience:1, location:'Remote', remoteType:'remote', founderOpenToRelocation:false, founderOpenToRemoteOnly:false, salaryMin:90000, founderMinAcceptableSalary:70000, postedAt:new Date().toISOString(), discoveredAt:new Date().toISOString(), extraScreenerQuestionCount:0, signals:baseSignals, verifiedSponsorshipOverride:false,
}

describe('scoreCandidate — hard blockers override score (#192)', () => {
  it('a strong-fit posting scores highly and auto-queues when no hard blocker applies', () => { const r=scoreCandidate(strongFitBase); expect(r.score).toBeGreaterThanOrEqual(85); expect(r.bucket).toBe('auto_queue') })
  it('rejects explicit OPT exclusion regardless of score', () => { const r=scoreCandidate({...strongFitBase,signals:{...baseSignals,optExcluded:true,evidence:['no OPT candidates']}}); expect(r.bucket).toBe('reject'); expect(r.gate.outcome).toBe('blocked') })
  it('rejects citizenship requirement regardless of score', () => { expect(scoreCandidate({...strongFitBase,signals:{...baseSignals,citizenshipRequired:true,evidence:['citizens only']}}).bucket).toBe('reject') })
  it('rejects active-clearance requirement regardless of score', () => { expect(scoreCandidate({...strongFitBase,signals:{...baseSignals,clearanceRequired:true,evidence:['active TS/SCI clearance required']}}).bucket).toBe('reject') })
  it('rejects a hard 8+ year experience gap', () => { const r=scoreCandidate({...strongFitBase,minYearsExperienceRequired:8}); expect(r.bucket).toBe('reject'); expect(r.gate.outcome).toBe('blocked') })
  it('routes ambiguous sponsorship language to review', () => { expect(scoreCandidate({...strongFitBase,signals:{...baseSignals,ambiguousEligibilityLanguage:true,evidence:['sponsorship']}}).bucket).toBe('review_low_priority') })
  it('rejects a weak fit without filling quota', () => { const r=scoreCandidate({...strongFitBase,title:'Marketing Coordinator',targetTitles:['Software Engineer I'],candidateSkills:['Adobe Photoshop','Copywriting'],minYearsExperienceRequired:3,founderYearsExperience:0,remoteType:'on_site',founderOpenToRelocation:false,salaryMin:null,founderMinAcceptableSalary:70000,postedAt:new Date(Date.now()-2592000000).toISOString()}); expect(r.bucket).toBe('reject'); expect(r.score).toBeLessThan(50) })
})

describe('scoreCandidate — career-level title calibration', () => {
  it('treats explicit entry-level software engineer as a full target-family title match', () => {
    const r=scoreCandidate({...strongFitBase,title:'Software Engineer - Entry Level 2027',targetTitles:['Junior Software Engineer','Software Engineer I']})
    expect(r.breakdown.titleFit).toBe(20)
  })
  it('does not let a senior generic engineer title outrank early-career targets', () => {
    const senior=scoreCandidate({...strongFitBase,title:'Senior Software Engineer',targetTitles:['Junior Software Engineer','Software Engineer I'],minYearsExperienceRequired:null})
    const entry=scoreCandidate({...strongFitBase,title:'Software Engineer - Entry Level',targetTitles:['Junior Software Engineer','Software Engineer I'],minYearsExperienceRequired:null})
    expect(senior.breakdown.titleFit).toBe(5)
    expect(entry.breakdown.titleFit).toBe(20)
    expect(entry.score).toBeGreaterThan(senior.score)
  })
})

describe('scoreCandidate — support-family calibration', () => {
  const supportBase: ScoringInput = {
    ...strongFitBase,
    title:'Technical Support Engineer',
    targetTitles:['IT Support Technician','Help Desk Technician','Technical Support Specialist'],
    candidateSkills:['Zendesk','TCP/IP','SaaS troubleshooting'],
    founderSkills:['TypeScript','SQL','Troubleshooting','Google Workspace'],
    requiresDegree:'unknown',
    minYearsExperienceRequired:null,
    founderYearsExperience:0,
    salaryMin:null,
    founderMinAcceptableSalary:null,
    location:'United States - Remote',
    remoteType:'remote',
  }

  it('gives a non-senior technical-support role full target-family title credit', () => {
    const r=scoreCandidate(supportBase)
    expect(r.breakdown.titleFit).toBe(20)
  })

  it('uses an unknown-neutral stack floor for support roles instead of zero', () => {
    const r=scoreCandidate(supportBase)
    expect(r.breakdown.stackOverlap).toBe(8)
    expect(r.score).toBeGreaterThanOrEqual(70)
    expect(r.bucket).toBe('queue_if_capacity')
  })

  it('does not penalize <=2 years on an explicit L1/frontline role', () => {
    const r=scoreCandidate({...supportBase,title:'Technical Support Engineer (L1/Frontline Support)',minYearsExperienceRequired:2})
    expect(r.breakdown.experienceGapPenalty).toBe(0)
  })

  it('still penalizes a 3-year requirement even when the title says associate', () => {
    const r=scoreCandidate({...strongFitBase,title:'Associate Software Engineer',minYearsExperienceRequired:3,founderYearsExperience:0})
    expect(r.breakdown.experienceGapPenalty).toBe(15)
  })

  it('does not award full US-remote location credit to a region-locked APAC role', () => {
    const us=scoreCandidate({...supportBase,location:'Remote / Boston / New York'})
    const apac=scoreCandidate({...supportBase,location:'Remote / Hong Kong / Singapore / Tokyo'})
    expect(us.breakdown.locationFit).toBe(12)
    expect(apac.breakdown.locationFit).toBe(0)
    expect(us.score).toBeGreaterThan(apac.score)
  })

  it('keeps senior support titles below the target-family score', () => {
    const r=scoreCandidate({...supportBase,title:'Senior Technical Support Engineer'})
    expect(r.breakdown.titleFit).toBe(5)
  })
})
