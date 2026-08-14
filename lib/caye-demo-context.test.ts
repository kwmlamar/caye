import { describe, expect, it } from 'vitest'
import { withDemoBusinessFacts } from './caye-demo-context'

describe('withDemoBusinessFacts', () => {
  it('adds the live guest-facing business-facts block to the demo context', () => {
    const prompt = withDemoBusinessFacts(
      'You are Caye for Bowcar Rentals.',
      'BUSINESS FACTS — what the owner has taught you about this business.\n\nPOLICIES:\n- Children need car seats.\n\nSPECIAL HANDLING:\n- Temporary 15% promotion is active.'
    )

    expect(prompt).toContain('You are Caye for Bowcar Rentals.')
    expect(prompt).toContain('Children need car seats.')
    expect(prompt).toContain('Temporary 15% promotion is active.')
  })

  it('leaves the prompt untouched when the workspace has no active facts', () => {
    expect(withDemoBusinessFacts('base prompt', '   ')).toBe('base prompt')
  })
})
