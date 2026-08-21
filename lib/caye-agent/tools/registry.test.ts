import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { TOOL_REGISTRY, findTool } from './registry'
import { HIGH_RISK_TOOLS, findHighRiskTool } from './high-risk-registry'

describe('TOOL_REGISTRY — structural invariants', () => {
  it('registers every tool name exactly once', () => {
    const names = TOOL_REGISTRY.map((t) => t.name)
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i)
    expect(duplicates).toEqual([])
  })

  it('every high-risk tool the model can see is wrapped (gateHighRisk) exactly once, not also present unwrapped', () => {
    // A tool that shipped both a raw entry (autonomous) and a gated entry
    // (staged) would let the model call the raw one and skip confirmation
    // entirely — the exact failure class the write-high move exists to
    // prevent. TOOL_REGISTRY exposes only tool.execute closures, so the
    // structural proxy for "wrapped" is: every name in HIGH_RISK_TOOLS
    // appears in TOOL_REGISTRY tagged risk:'high', and appears there only
    // once (checked by the dedupe test above).
    const registryNames = new Set(TOOL_REGISTRY.map((t) => t.name))
    for (const highRisk of HIGH_RISK_TOOLS) {
      expect(registryNames.has(highRisk.name)).toBe(true)
      const inRegistry = TOOL_REGISTRY.find((t) => t.name === highRisk.name)
      expect(inRegistry?.risk).toBe('high')
    }
  })
})

describe('draft_in_inbox — registration (2026-08-17 Pam Ott incident, write-low → write-high move)', () => {
  it('is registered exactly once in TOOL_REGISTRY', () => {
    const matches = TOOL_REGISTRY.filter((t) => t.name === 'draft_in_inbox')
    expect(matches).toHaveLength(1)
  })

  it('is high-risk, back-office only, owner/founder only', () => {
    const tool = findTool('draft_in_inbox')
    expect(tool?.risk).toBe('high')
    expect(tool?.modes).toEqual(['back-office'])
    expect(tool?.roles).toEqual(['owner', 'founder'])
  })

  it('is confirmable — present in HIGH_RISK_TOOLS exactly once, findable by findHighRiskTool', () => {
    const matches = HIGH_RISK_TOOLS.filter((t) => t.name === 'draft_in_inbox')
    expect(matches).toHaveLength(1)
    expect(findHighRiskTool('draft_in_inbox')?.name).toBe('draft_in_inbox')
  })

  it('the TOOL_REGISTRY entry and the HIGH_RISK_TOOLS entry are the same underlying tool (no drift between the two lists)', () => {
    // gateHighRisk wraps execute but preserves the tool's identity fields —
    // description, risk, roles, modes all pass through unchanged. If the
    // move had left a second, differently-configured draft_in_inbox behind
    // (e.g. a stale low-risk copy), these would disagree.
    const registered = findTool('draft_in_inbox')
    const highRisk = findHighRiskTool('draft_in_inbox')
    expect(registered?.description).toBe(highRisk?.description)
    expect(registered?.risk).toBe(highRisk?.risk)
    expect(registered?.roles).toEqual(highRisk?.roles)
    expect(registered?.modes).toEqual(highRisk?.modes)
  })
})

describe('production tool registry — unrelated classifications unchanged by the move', () => {
  // A handful of tools whose risk tier is load-bearing elsewhere (evidence
  // gate, autonomy prose, other regression tests) — pinned here so a future
  // reorg touching this file trips a test instead of silently reclassifying
  // something it didn't mean to.
  const expected: Array<[string, 'read' | 'low' | 'high']> = [
    ['send_reply', 'high'],
    ['confirm_pending_action', 'high'],
    ['add_business_fact', 'low'],
    ['get_held_queue', 'read'],
    ['remove_pricing_tier', 'high'],
    ['send_outreach_batch', 'high'],
  ]

  it.each(expected)('%s stays risk=%s', (name, risk) => {
    expect(findTool(name)?.risk).toBe(risk)
  })
})
