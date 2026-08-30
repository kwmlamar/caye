import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('interruption policy runtime integration', () => {
  const gate = source('lib/whatsapp/operator-notification-gate.ts')
  const migration = source('supabase/migrations/20260830_interruption_policy_audit.sql')

  it('uses the canonical deterministic policy inside the existing notification choke point', () => {
    expect(gate).toContain("from '@/lib/interruption-policy'")
    expect(gate).toContain('evaluateInterruption({')
    expect(gate).toContain('changeKind')
    expect(gate).toContain('confidence: args.input.confidence')
    expect(gate).toContain('authorityAllowsAutonomousAction')
  })

  it('accepts urgency and importance as independent structured dimensions', () => {
    expect(gate).toContain('urgency?: InterruptionLevel')
    expect(gate).toContain('importance?: InterruptionLevel')
    expect(gate).toContain('urgency: args.input.urgency ?? defaults.urgency')
    expect(gate).toContain('importance: args.input.importance ?? defaults.importance')
  })

  it('keeps the interruption budget in the shared gate rather than individual producers', () => {
    expect(gate).toContain('const DAILY_INTERRUPTION_BUDGET = 3')
    expect(gate).toContain('interruptionBudgetExhausted(input.workspaceId)')
    expect(gate).toContain("const BUDGET_PRIORITIES = new Set<AttentionPriority>(['awareness', 'routine'])")
  })

  it('budgets actual sent proactive queue rows, not ordinary conversation turns or failed attempts', () => {
    expect(gate).toContain(".from('caye_outbound_queue')")
    expect(gate).toContain(".eq('status', 'sent')")
    expect(gate).toContain(".gte('sent_at', since)")
  })

  it('persists policy verdict plus evaluated dimensions on the existing owner-attention ledger', () => {
    expect(gate).toContain('last_policy_decision: { ...decision, dimensions }')
    expect(gate).toContain('last_policy_decided_at: new Date().toISOString()')
    expect(gate).toContain('interruptionBudgetExhausted: args.budgetExhausted')
    expect(migration).toContain('alter table public.caye_owner_attention')
    expect(migration).toContain('last_policy_decision jsonb')
    expect(migration).toContain('last_policy_decided_at timestamptz')
  })

  it('does not create a parallel interruption table', () => {
    expect(migration).not.toMatch(/create\s+table/i)
  })

  it('keeps policy-audit failure non-blocking', () => {
    expect(gate).toContain('policy audit failed')
    expect(gate).toContain('Audit bookkeeping must never suppress a real operator notification')
  })
})
