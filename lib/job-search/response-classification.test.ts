import { describe, expect, it } from 'vitest'
import {
  applicationStatusForResponse,
  classifyInboundEmail,
  classifyRecruiterResponse,
  isPositiveResponse,
  resolveApplicationStatusAfterResponse,
  responsePriority,
} from './response-classification'

describe('recruiter response classification', () => {
  it.each([
    ['Unfortunately, we will not be moving forward with your application.', 'rejection'],
    ['I came across your profile and would love to connect about our support engineer role.', 'recruiter_interest'],
    ['Can we set up an initial call next week?', 'screen_request'],
    ['We would like to invite you to interview with the team.', 'interview_request'],
    ['Please complete the technical assessment by Friday.', 'assessment'],
    ['Could you please send an updated resume?', 'additional_information'],
    ['Please share your availability so we can find a time to chat.', 'scheduling'],
    ['We are pleased to offer you the position.', 'offer'],
    ['Your message has been received.', 'unknown'],
  ])('classifies %s', (text, expected) => {
    expect(classifyRecruiterResponse(text)).toBe(expected)
  })

  it.each([
    [
      'Unfortunately, we will not be moving forward. Please use the link below if you would like to schedule time with recruiting.',
      'rejection',
    ],
    [
      'We were impressed by your background, but unfortunately we will not be moving forward with your application.',
      'rejection',
    ],
    [
      'We are pleased to offer you the position. Please book a time on my calendar to discuss details.',
      'offer',
    ],
    [
      'Please complete the technical assessment, then share your availability for a follow-up.',
      'assessment',
    ],
    [
      'Thanks for applying. Your application has been received. We were impressed by your background and would love to connect.',
      'recruiter_interest',
    ],
    [
      'Thanks for your interest. We will review everything and be in touch if there is a next step.',
      'unknown',
    ],
  ])('uses safe precedence for mixed message: %s', (text, expected) => {
    expect(classifyInboundEmail(text)).toBe(expected)
  })

  it('treats an application receipt as confirmation, not recruiter engagement', () => {
    expect(classifyInboundEmail('Thanks for applying. Your application has been received.')).toBe('confirmation_check')
  })

  it('does not let confirmation wording mask a rejection', () => {
    expect(classifyInboundEmail('Thanks for applying. Unfortunately, we will not be moving forward.')).toBe('rejection')
  })

  it('never maps rejection to FOLLOWUP_DUE', () => {
    expect(applicationStatusForResponse('rejection')).toBe('REJECTED')
  })

  it('maps interviews and offers to the canonical application states', () => {
    expect(applicationStatusForResponse('screen_request')).toBe('INTERVIEW')
    expect(applicationStatusForResponse('interview_request')).toBe('INTERVIEW')
    expect(applicationStatusForResponse('offer')).toBe('OFFER')
  })

  it('does not regress INTERVIEW or OFFER on later positive replies', () => {
    expect(resolveApplicationStatusAfterResponse('INTERVIEW', 'recruiter_interest')).toBe('INTERVIEW')
    expect(resolveApplicationStatusAfterResponse('INTERVIEW', 'scheduling')).toBe('INTERVIEW')
    expect(resolveApplicationStatusAfterResponse('OFFER', 'additional_information')).toBe('OFFER')
  })

  it('still permits progression and terminal rejection', () => {
    expect(resolveApplicationStatusAfterResponse('FOLLOWUP_DUE', 'screen_request')).toBe('INTERVIEW')
    expect(resolveApplicationStatusAfterResponse('INTERVIEW', 'offer')).toBe('OFFER')
    expect(resolveApplicationStatusAfterResponse('INTERVIEW', 'rejection')).toBe('REJECTED')
  })

  it('prioritizes recruiter interest over unknown mail', () => {
    expect(responsePriority('recruiter_interest')).toBeGreaterThan(responsePriority('unknown'))
    expect(isPositiveResponse('recruiter_interest')).toBe(true)
    expect(isPositiveResponse('rejection')).toBe(false)
    expect(isPositiveResponse('unknown')).toBe(false)
  })
})
