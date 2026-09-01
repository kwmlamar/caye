import { describe, expect, it } from 'vitest'
import {
  classifyInboundEmail,
  classifyRecruiterResponse,
  isRoutineReplyCategory,
} from './response-classification'

describe('classifyRecruiterResponse', () => {
  it('classifies a rejection even when the email also mentions "interview"', () => {
    const text =
      'Thank you for interviewing with us. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches this role.'
    expect(classifyRecruiterResponse(text)).toBe('rejection')
  })

  it('classifies a plain rejection', () => {
    const text = 'After careful consideration, we will not be moving forward with your application at this time.'
    expect(classifyRecruiterResponse(text)).toBe('rejection')
  })

  it('classifies an offer', () => {
    const text = 'We are pleased to offer you the Senior Engineer position. Please find the offer letter attached.'
    expect(classifyRecruiterResponse(text)).toBe('offer')
  })

  it('classifies an interview request', () => {
    const text = "We'd like to schedule an interview with our engineering team next week."
    expect(classifyRecruiterResponse(text)).toBe('interview_request')
  })

  it('classifies a phone screen request distinctly from a full interview', () => {
    const text = 'Our recruiter would like to set up a quick call to chat about your background before the interview process.'
    expect(classifyRecruiterResponse(text)).toBe('screen_request')
  })

  it('classifies a take-home assessment', () => {
    const text = 'Next step is a take-home assessment via HackerRank — you have 5 days to complete it.'
    expect(classifyRecruiterResponse(text)).toBe('assessment')
  })

  it('classifies generic scheduling language', () => {
    const text = "What's your availability this week? Feel free to book a time on my calendar via calendly.com/jane"
    expect(classifyRecruiterResponse(text)).toBe('scheduling')
  })

  it('classifies a request for more documents', () => {
    const text = 'Could you please send an updated resume and two references at your earliest convenience?'
    expect(classifyRecruiterResponse(text)).toBe('additional_information')
  })

  it('classifies soft recruiter interest with no concrete next step', () => {
    const text = 'I came across your profile and think you could be a great fit for our platform team — would love to connect.'
    expect(classifyRecruiterResponse(text)).toBe('recruiter_interest')
  })

  it('falls back to unknown for unrecognized content', () => {
    expect(classifyRecruiterResponse('Please see attached for our updated privacy policy.')).toBe('unknown')
  })
})

describe('classifyInboundEmail', () => {
  it('classifies an application-received autoresponder as confirmation_check, not a real response', () => {
    const text = 'Thanks for applying! We have received your application and will be in touch if there is a match.'
    expect(classifyInboundEmail(text)).toBe('confirmation_check')
  })

  it('does not let a rejection that also thanks the applicant fall into confirmation_check', () => {
    const text = 'Thank you for applying. Unfortunately we will not be moving forward with your candidacy.'
    expect(classifyInboundEmail(text)).toBe('rejection')
  })
})

describe('isRoutineReplyCategory', () => {
  it('allows drafting for routine low-risk categories', () => {
    expect(isRoutineReplyCategory('recruiter_interest')).toBe(true)
    expect(isRoutineReplyCategory('screen_request')).toBe(true)
    expect(isRoutineReplyCategory('scheduling')).toBe(true)
    expect(isRoutineReplyCategory('additional_information')).toBe(true)
  })

  it('blocks drafting for founder-only categories even though some overlap the allowlist wording', () => {
    expect(isRoutineReplyCategory('offer')).toBe(false)
    expect(isRoutineReplyCategory('rejection')).toBe(false)
    expect(isRoutineReplyCategory('interview_request')).toBe(false)
    expect(isRoutineReplyCategory('unknown')).toBe(false)
  })
})
