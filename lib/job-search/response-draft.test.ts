import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

const state: { application: Row | null; followups: Row[]; profile: Row | null } = {
  application: null,
  followups: [],
  profile: null,
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'job_search_applications') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.application, error: null }) }) }) }
      }
      if (table === 'job_search_followups') {
        return { select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: state.followups, error: null }) }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

vi.mock('./profile', () => ({
  getActiveProfile: async () => state.profile,
}))

import { draftRecruiterReply } from './response-draft'

function seed() {
  state.application = { id: 'app_1', status: 'FOLLOWUP_DUE', candidate: { company: 'Acme Corp', title: 'Backend Engineer' } }
  state.profile = { status: 'verified', fullName: 'Lamar', contactEmail: 'lamar@example.com', contactPhone: '555-0100' }
  state.followups = []
}

beforeEach(seed)

describe('draftRecruiterReply — category gating', () => {
  it('drafts a reply for a routine category (recruiter_interest)', async () => {
    state.followups = [{ followup_type: 'recruiter_interest', direction: 'inbound', source_email_ref: 'zoho:msg_1', note: 'jane@acmecorp.com: Your background', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.to).toBe('jane@acmecorp.com')
      expect(result.draft.replyToMessageId).toBe('msg_1')
      expect(result.draft.body).toContain('Backend Engineer')
    }
  })

  it('refuses to draft for a founder-only category (offer) no matter what', async () => {
    state.followups = [{ followup_type: 'offer', direction: 'inbound', source_email_ref: 'zoho:msg_1', note: 'jane@acmecorp.com: Offer', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.category).toBe('offer')
  })

  it('refuses to draft for rejection', async () => {
    state.followups = [{ followup_type: 'rejection', direction: 'inbound', source_email_ref: 'zoho:msg_1', note: 'jane@acmecorp.com: Update', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(false)
  })

  it('refuses to draft for interview_request (a specific commitment, not a routine ack)', async () => {
    state.followups = [{ followup_type: 'interview_request', direction: 'inbound', source_email_ref: 'zoho:msg_1', note: 'jane@acmecorp.com: Interview', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(false)
  })

  it('refuses to draft a reply that would sign the founder\'s name when the profile is not verified', async () => {
    state.profile = { status: 'needs_verification', fullName: null, contactEmail: null, contactPhone: null }
    state.followups = [{ followup_type: 'recruiter_interest', direction: 'inbound', source_email_ref: 'zoho:msg_1', note: 'jane@acmecorp.com: Hi', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(false)
  })

  it('drafts a check-in follow-up when a check-in marker is pending and a prior contact is known', async () => {
    state.followups = [
      { followup_type: 'scheduled_followup', direction: 'outbound', source_email_ref: null, note: 'Automated check-in due', sent_at: null },
      { followup_type: 'recruiter_interest', direction: 'inbound', source_email_ref: 'zoho:msg_0', note: 'jane@acmecorp.com: Hi', sent_at: null },
    ]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft.to).toBe('jane@acmecorp.com')
      expect(result.draft.category).toBe('scheduled_followup')
    }
  })

  it('refuses to draft a check-in when there is no known contact at all (cold ATS submission)', async () => {
    state.followups = [{ followup_type: 'scheduled_followup', direction: 'outbound', source_email_ref: null, note: 'Automated check-in due', sent_at: null }]
    const result = await draftRecruiterReply('app_1')
    expect(result.ok).toBe(false)
  })
})
