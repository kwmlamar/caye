import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Structural regression tests for the owner-facing communication/UI fixes
 * prompted by the 2026-08-28 Bimini operator transcript. These intentionally
 * test the durable instruction/wiring rather than pinning stochastic model
 * wording.
 */
describe('operator-facing response compression', () => {
  const agentSource = readFileSync(join(process.cwd(), 'lib/caye-agent/index.ts'), 'utf8')

  it('keeps the final compression block after dynamic operational context', () => {
    expect(agentSource).toContain('FINAL OPERATOR COMMUNICATION CHECK — compress before you send')
    expect(agentSource).toContain('WHAT CHANGED → the one fact that matters → what you recommend/can do → approval only if it is actually required')
    expect(agentSource).toContain('Routine operator updates should usually fit in 1–4 short sentences')
    expect(agentSource).toMatch(/activeWorkContext\) \+ OPERATOR_RESPONSE_COMPRESSION/)
  })

  it('forbids vague unknowns and unsupported policy conclusions', () => {
    expect(agentSource).toContain('Never say vague things like "something outside what I know"')
    expect(agentSource).toContain('Never convert a customer request into a business conclusion')
    expect(agentSource).toContain('"that timeline works" is a policy judgment and requires authoritative business evidence')
  })
})

describe('team/operator transcript alignment', () => {
  const css = readFileSync(join(process.cwd(), 'app/caye-direct-composer.css'), 'utf8')

  it('removes the duplicate 26px Caye-row offset while preserving the avatar-column layout', () => {
    expect(css).toContain('img[alt="Caye"]')
    expect(css).toContain('[style*="margin-left: 26px"]')
    expect(css).toMatch(/img\[alt="Caye"\][\s\S]*margin-left:\s*0\s*!important/)
  })
})
