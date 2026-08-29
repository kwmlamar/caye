/**
 * Job-search operator (#192) — recruiter-email correlation interface.
 *
 * DEFERRED (see PR description / follow-up GitHub issue referencing #192).
 * Real Gmail ingestion already exists in this repo (app/api/email/gmail-
 * poll/route.ts, lib/channels/email-provider.ts, lib/contacts/resolve-
 * contact.ts) but it is scoped to Bimini's customer-workspace inbox
 * correlation today. Wiring a SECOND, founder-personal Gmail correlation
 * path safely — without letting an unrelated customer email accidentally
 * enter founder job-search context, and without conflating the founder's
 * personal inbox OAuth grant with a workspace's — is exactly the kind of
 * "explode scope" risk the dispatch says to wire an interface for and
 * defer rather than build inline.
 *
 * This module exists so job_search_followups has a defined, typed
 * insertion point (correlateRecruiterEmail) for that follow-up work,
 * without a real network/OAuth dependency landing in this PR. Calling it
 * today always returns 'not_implemented' — it never silently no-ops as
 * though nothing were wrong, and it can never be reached by any customer-
 * workspace code path (nothing in lib/channels/email-provider.ts or the
 * Gmail poller imports this module).
 */
import 'server-only'

export type RecruiterEmailCorrelationInput = {
  applicationId: string
  emailSubject: string
  emailFrom: string
  emailSnippet: string
}

export type RecruiterEmailCorrelationResult =
  | { status: 'not_implemented' }
  | { status: 'correlated'; followupType: 'confirmation_check' | 'recruiter_reply' | 'interview_request' }
  | { status: 'no_match' }

export async function correlateRecruiterEmail(
  _input: RecruiterEmailCorrelationInput,
): Promise<RecruiterEmailCorrelationResult> {
  return { status: 'not_implemented' }
}
