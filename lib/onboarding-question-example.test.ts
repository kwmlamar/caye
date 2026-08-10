import { describe, it, expect } from 'vitest'
import { splitInlineExample, unwrapExample } from './onboarding-question-example'

describe('splitInlineExample', () => {
  // Both of these are verbatim from a real onboarding thread where the
  // owner saw two examples per question.
  it('strips an inline example introduced after a question mark', () => {
    const result = splitInlineExample(
      "How many people can you take per trip, any age/health restrictions, and are there trips every day? e.g. 'Max 10 guests, kids 6+ welcome, trips run daily at 8am and 1pm, closed Sundays'"
    )
    expect(result.question).toBe(
      'How many people can you take per trip, any age/health restrictions, and are there trips every day?'
    )
    expect(result.example).toBe(
      'Max 10 guests, kids 6+ welcome, trips run daily at 8am and 1pm, closed Sundays'
    )
  })

  it('strips an inline example introduced by an em dash', () => {
    const result = splitInlineExample(
      "What's your vibe, and is there anything customers often ask that we should know — e.g. 'We're relaxed and fun, customers always ask if we see pigs or sharks, and yes we sometimes stop at Pig Beach'"
    )
    expect(result.question).toBe(
      "What's your vibe, and is there anything customers often ask that we should know"
    )
    // Apostrophe inside the example survives; only the wrapping quotes go.
    expect(result.example).toBe(
      "We're relaxed and fun, customers always ask if we see pigs or sharks, and yes we sometimes stop at Pig Beach"
    )
  })

  it('strips a parenthesised example', () => {
    const result = splitInlineExample(
      'What do you charge? (e.g. "$95 per person, kids half price")'
    )
    expect(result.question).toBe('What do you charge?')
    expect(result.example).toBe('$95 per person, kids half price')
  })

  it('handles "for example" and "for instance" as lead-ins', () => {
    expect(splitInlineExample('When are you open? For example, 9am to 5pm daily').question).toBe(
      'When are you open?'
    )
    expect(splitInlineExample('Who handles refunds — for instance, the owner').question).toBe(
      'Who handles refunds'
    )
  })

  it('leaves a clean question untouched', () => {
    const q = 'What is your cancellation policy?'
    expect(splitInlineExample(q)).toEqual({ question: q, example: null })
  })

  it('does not match word-internal "eg"', () => {
    const q = 'Is the tour accessible for guests with a bad leg. Any mobility limits?'
    expect(splitInlineExample(q).example).toBeNull()
  })

  it('leaves the text alone when there is no question before the example', () => {
    const q = 'e.g. Max 6 guests'
    expect(splitInlineExample(q)).toEqual({ question: q, example: null })
  })
})

describe('unwrapExample', () => {
  it('strips wrapping quotes without touching internal apostrophes', () => {
    expect(unwrapExample('"We\'re open daily"')).toBe("We're open daily")
    expect(unwrapExample("  'Max 6 guests'  ")).toBe('Max 6 guests')
  })

  it('returns an empty string unchanged', () => {
    expect(unwrapExample('')).toBe('')
  })
})
