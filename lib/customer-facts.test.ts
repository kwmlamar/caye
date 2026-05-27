import { describe, it, expect } from 'vitest'
import { formatCustomerFactsBlock, hasFacts, type CustomerFacts } from './customer-facts'

describe('hasFacts', () => {
  it('returns false for null / undefined / empty', () => {
    expect(hasFacts(null)).toBe(false)
    expect(hasFacts(undefined)).toBe(false)
    expect(hasFacts({})).toBe(false)
    expect(hasFacts({ dietary: [], mobility: [], preferences: [], occasions: [] })).toBe(false)
  })

  it('returns false when group_composition is blank/whitespace', () => {
    expect(hasFacts({ group_composition: '' })).toBe(false)
    expect(hasFacts({ group_composition: '   ' })).toBe(false)
    expect(hasFacts({ group_composition: null })).toBe(false)
  })

  it('returns true when any single field has content', () => {
    expect(hasFacts({ dietary: ['vegetarian'] })).toBe(true)
    expect(hasFacts({ mobility: ['wheelchair user'] })).toBe(true)
    expect(hasFacts({ group_composition: '2 adults + 1 child' })).toBe(true)
    expect(hasFacts({ preferences: ['morning tours'] })).toBe(true)
    expect(hasFacts({ occasions: ['anniversary'] })).toBe(true)
  })
})

describe('formatCustomerFactsBlock', () => {
  it('returns empty string when no facts are populated', () => {
    expect(formatCustomerFactsBlock(null)).toBe('')
    expect(formatCustomerFactsBlock({})).toBe('')
    expect(formatCustomerFactsBlock({ dietary: [] })).toBe('')
  })

  it('opens with the CUSTOMER FACTS header', () => {
    const block = formatCustomerFactsBlock({ dietary: ['vegetarian'] })
    expect(block).toMatch(/^CUSTOMER FACTS/)
  })

  it('joins dietary array with commas', () => {
    const block = formatCustomerFactsBlock({
      dietary: ['vegetarian', 'shellfish allergy', 'gluten-free'],
    })
    expect(block).toContain('Dietary / allergies: vegetarian, shellfish allergy, gluten-free')
  })

  it('includes mobility line when populated', () => {
    const block = formatCustomerFactsBlock({ mobility: ['wheelchair user'] })
    expect(block).toContain('Mobility / accessibility: wheelchair user')
  })

  it('renders group composition on its own line', () => {
    const block = formatCustomerFactsBlock({ group_composition: '2 adults + 1 child age 5' })
    expect(block).toContain('Group: 2 adults + 1 child age 5')
  })

  it('renders preferences and occasions when present', () => {
    const block = formatCustomerFactsBlock({
      preferences: ['morning tours', 'small groups'],
      occasions: ['anniversary'],
    })
    expect(block).toContain('Preferences: morning tours, small groups')
    expect(block).toContain('Occasions noted: anniversary')
  })

  it("tells Caye not to recite the list back", () => {
    const block = formatCustomerFactsBlock({ dietary: ['vegetarian'] })
    expect(block.toLowerCase()).toContain("don't recite")
  })

  it('tells Caye to trust the latest message when facts conflict', () => {
    const block = formatCustomerFactsBlock({ dietary: ['vegetarian'] })
    expect(block.toLowerCase()).toContain('trust the new message')
  })

  it('omits empty fields cleanly when others are present', () => {
    const facts: CustomerFacts = {
      dietary: ['vegetarian'],
      mobility: [],
      group_composition: null,
      preferences: [],
      occasions: [],
    }
    const block = formatCustomerFactsBlock(facts)
    expect(block).toContain('Dietary')
    expect(block).not.toContain('Mobility')
    expect(block).not.toContain('Group:')
    expect(block).not.toContain('Preferences')
    expect(block).not.toContain('Occasions')
  })
})
