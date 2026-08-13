import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseCheckConstraints, allowedValues } from '../db/check-constraints'
import {
  SALES_STAGES,
  deriveStage,
  isForwardTransition,
  isTerminal,
  type StageEvidence,
} from './funnel'

function evidence(over: Partial<StageEvidence> = {}): StageEvidence {
  return {
    optedOut: false,
    disqualified: false,
    isPaying: false,
    demoCompleted: false,
    demoOpened: false,
    qualified: false,
    hasReplied: false,
    contacted: false,
    cadenceExhausted: false,
    ...over,
  }
}

describe('SALES_STAGES vs the database', () => {
  it('matches the outreach_leads.stage CHECK constraint exactly', () => {
    // Reads the allowed values out of the migrations rather than a
    // hand-written copy, reusing lib/db/check-constraints.ts. Adding a stage
    // in code without a migration fails here instead of throwing a
    // constraint violation in production.
    const dir = join(process.cwd(), 'supabase/migrations')
    const migrations = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))

    const allowed = allowedValues(parseCheckConstraints(migrations), 'outreach_leads', 'stage')
    expect(allowed, 'no CHECK found for outreach_leads.stage').toBeTruthy()
    expect([...allowed!].sort()).toEqual([...SALES_STAGES].sort())
  })
})

describe('deriveStage', () => {
  it('reads a fresh lead as sourced', () => {
    expect(deriveStage(evidence())).toBe('sourced')
  })

  it('walks the funnel forward as evidence accumulates', () => {
    expect(deriveStage(evidence({ contacted: true }))).toBe('contacted')
    expect(deriveStage(evidence({ contacted: true, hasReplied: true }))).toBe('engaged')
    expect(deriveStage(evidence({ contacted: true, hasReplied: true, qualified: true }))).toBe('qualified')
    expect(deriveStage(evidence({ demoOpened: true }))).toBe('demo_started')
    expect(deriveStage(evidence({ demoCompleted: true }))).toBe('activated')
    expect(deriveStage(evidence({ isPaying: true }))).toBe('won')
  })

  it('lets stronger evidence win over weaker', () => {
    // Paying beats every behavioural signal beneath it.
    expect(deriveStage(evidence({ isPaying: true, demoOpened: true, hasReplied: true }))).toBe('won')
    // An explicit disqualification beats everything, including payment,
    // because it is a decision rather than an observation.
    expect(deriveStage(evidence({ disqualified: true, isPaying: true }))).toBe('disqualified')
  })

  it('distinguishes an opt-out from someone who engaged vs someone who never did', () => {
    expect(deriveStage(evidence({ optedOut: true, hasReplied: true }))).toBe('lost')
    expect(deriveStage(evidence({ optedOut: true }))).toBe('disqualified')
  })

  it('marks an exhausted cadence as lost, not still-contacted', () => {
    expect(deriveStage(evidence({ contacted: true, cadenceExhausted: true }))).toBe('lost')
  })
})

describe('isForwardTransition', () => {
  it('allows progress and rejects regression', () => {
    expect(isForwardTransition('contacted', 'engaged')).toBe(true)
    expect(isForwardTransition('engaged', 'contacted')).toBe(false)
    expect(isForwardTransition('engaged', 'engaged')).toBe(false)
  })

  it('allows skipping stages, because real funnels skip', () => {
    // A first-touch reply of "yes, I want this" is contacted -> qualified in
    // one message. Refusing that would force recording something false.
    expect(isForwardTransition('contacted', 'qualified')).toBe(true)
    expect(isForwardTransition('sourced', 'won')).toBe(true)
  })

  it('always allows dropping to a terminal stage from anywhere', () => {
    expect(isForwardTransition('activated', 'lost')).toBe(true)
    expect(isForwardTransition('qualified', 'disqualified')).toBe(true)
  })
})

describe('isTerminal', () => {
  it('covers exactly the stop-work stages', () => {
    expect(SALES_STAGES.filter(isTerminal)).toEqual(['won', 'lost', 'disqualified'])
  })
})
