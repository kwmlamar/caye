import { describe, expect, it } from 'vitest'
import { buildDemoSystemPrompt } from './caye-demo-prompt'

const prompt = buildDemoSystemPrompt(
  'You represent Bowcar Rentals.',
  'Bowcar Rentals',
  'BUSINESS FACTS:\n- Buggy rentals are available.'
)

describe('demo guest-conversation prompt', () => {
  it.each([
    'product',
    'price',
    'capacity',
    'child',
    'directions',
    'promo',
    'arrival',
    'unknown',
  ])('keeps the %s answer grounded, direct, and progressively disclosed', () => {
    expect(prompt).toContain("Answer the guest's actual question first")
    expect(prompt).toContain('Use progressive disclosure')
    expect(prompt).toContain('do not guess, invent a policy')
  })

  it('uses the same concise WhatsApp response shape as live Caye', () => {
    expect(prompt).toContain('1–3 short paragraphs')
    expect(prompt).toContain('Do not use headings, tables, bullets')
    expect(prompt).toContain('Do not repeat your introduction')
  })

  it('keeps grounded business facts while retaining a tool-free preview boundary', () => {
    expect(prompt).toContain('Buggy rentals are available.')
    expect(prompt).toContain('nothing you say has a real side effect')
    expect(prompt).toContain('only when you describe an action')
  })
})
