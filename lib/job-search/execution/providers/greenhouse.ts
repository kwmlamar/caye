/**
 * Job-search operator (CAY-194 / #194) — Greenhouse ATS executor.
 *
 * WHY GREENHOUSE, WHY THIS PATH (see PR description for the full writeup):
 * Greenhouse's public Job Board API documents a supported application-
 * submission endpoint (https://developers.greenhouse.io/job-board.html —
 * "Submit an Application"): POST to the same
 * boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id} resource
 * this repo already trusts for discovery (lib/job-search/sources/greenhouse.ts),
 * plus a GET .../jobs/{job_id}?questions=true that returns the exact
 * required custom questions for that specific job as structured JSON
 * (field id, label, type, required, allowed values). That means field
 * discovery here is DETERMINISTIC JSON PARSING, not HTML scraping or an
 * LLM guessing form structure — and no browser is needed at all: no
 * Playwright/Puppeteer dependency, no page rendering, no click/type
 * automation, no session/cookie lifecycle to manage, and a dramatically
 * smaller SSRF surface than a real browser navigating an arbitrary page
 * would have (see ssrf-guard.ts's doc comment on what's still NOT closed
 * even here). Lever's public API is read-only for postings; it has no
 * documented write endpoint, so Lever applications would require real
 * browser automation against jobs.lever.co's hosted form — deliberately
 * out of scope for this PR (see providers/unsupported.ts).
 *
 * IMPORTANT — VERIFY BEFORE REAL ROLLOUT: the exact request/response shape
 * below (the `fields[].name` POST key format, the multipart field names,
 * and the success-response shape) is implemented from Greenhouse's public
 * documentation as of this PR's authoring. It has NOT been exercised
 * against a real Greenhouse board with a real submission — rollout is
 * disabled by default (see rollout.ts) specifically so this can be
 * verified against a real sandbox job before any real submission occurs.
 * See the PR description's "manual steps before first real submission."
 */
import type { AtsExecutorProvider } from './types'
import type { DiscoveredField, DomainValidation, FieldDiscoveryResult, SubmissionRequest, SubmissionResult } from '../types'
import { safeFetch } from '../safe-fetch'
import { isAllowedAtsHost } from '../allowed-destinations'
import { classifyFieldLabel } from '../field-classifier'

const GREENHOUSE_API_HOST = 'boards-api.greenhouse.io'
const REQUEST_TIMEOUT_MS = 15_000

type ParsedGreenhouseUrl = { boardToken: string; jobId: string }

/** Deterministic parse only — never guesses a board/job from a malformed URL. */
function parseGreenhouseApplyUrl(applyUrl: string): ParsedGreenhouseUrl | null {
  let url: URL
  try {
    url = new URL(applyUrl)
  } catch {
    return null
  }
  if (!isAllowedAtsHost('greenhouse', url.hostname)) return null
  const match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/)
  if (!match) return null
  return { boardToken: match[1], jobId: match[2] }
}

function isGreenhouseHost(hostname: string): boolean {
  return isAllowedAtsHost('greenhouse', hostname) || hostname === GREENHOUSE_API_HOST
}

type GreenhouseQuestionField = { name: string; type: string; required?: boolean; values?: { label: string; value: string }[] }
type GreenhouseQuestion = { label: string; required?: boolean; fields: GreenhouseQuestionField[] }
type GreenhouseJobDetail = { questions?: GreenhouseQuestion[] }

function mapInputType(ghType: string): DiscoveredField['inputType'] {
  switch (ghType) {
    case 'input_text':
    case 'short_text':
      return 'text'
    case 'textarea':
    case 'long_text':
      return 'textarea'
    case 'multi_value_single_select':
    case 'yes_no':
      return 'select'
    case 'multi_value_multi_select':
      return 'multi_select'
    case 'input_file':
      return 'file'
    default:
      return 'unknown'
  }
}

/** Detects a challenge/anti-bot response even though we expect clean JSON. Never used to bypass anything — only to decide whether to escalate. */
function detectChallengeSignal(status: number, contentType: string | null, bodyText: string): 'captcha' | 'anti_bot' | null {
  const lowerBody = bodyText.toLowerCase()
  if (/captcha/.test(lowerBody)) return 'captcha'
  if ((status === 403 || status === 503) && (!contentType || !contentType.includes('application/json'))) {
    if (/cloudflare|checking your browser|access denied|are you human|bot detection/.test(lowerBody) || lowerBody.length > 0) {
      return 'anti_bot'
    }
  }
  return null
}

export const greenhouseAtsProvider: AtsExecutorProvider = {
  providerKey: 'greenhouse',

  async discoverFields(applyUrl: string): Promise<FieldDiscoveryResult> {
    const parsed = parseGreenhouseApplyUrl(applyUrl)
    if (!parsed) return { outcome: 'malformed_url', reason: 'Apply URL is not a recognizable Greenhouse job URL (expected /{board}/jobs/{id}).' }

    const discoveryUrl = `https://${GREENHOUSE_API_HOST}/v1/boards/${encodeURIComponent(parsed.boardToken)}/jobs/${encodeURIComponent(parsed.jobId)}?questions=true`

    let result
    try {
      result = await safeFetch(discoveryUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, isGreenhouseHost)
    } catch (err) {
      return { outcome: 'discovery_failed', reason: err instanceof Error ? err.message : String(err), retryable: true }
    }

    if (result.outcome === 'blocked') {
      return { outcome: 'prohibited_destination', domainValidations: result.domainValidations, reason: result.reason }
    }
    if (result.outcome === 'too_many_redirects') {
      return { outcome: 'discovery_failed', reason: 'Too many redirects while resolving the Greenhouse job detail endpoint.', retryable: false }
    }

    const { response, domainValidations } = result
    const bodyText = await response.text()
    const challenge = detectChallengeSignal(response.status, response.headers.get('content-type'), response.ok ? '' : bodyText)
    if (challenge === 'captcha') return { outcome: 'captcha_detected', domainValidations, reason: 'CAPTCHA/challenge signal detected in Greenhouse response.' }
    if (challenge === 'anti_bot') return { outcome: 'anti_bot_detected', domainValidations, reason: 'Anti-bot/challenge response detected from Greenhouse.' }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return { outcome: 'discovery_failed', reason: `Greenhouse job detail fetch failed: ${response.status}`, retryable }
    }

    let body: GreenhouseJobDetail
    try {
      body = JSON.parse(bodyText) as GreenhouseJobDetail
    } catch {
      return { outcome: 'discovery_failed', reason: 'Greenhouse job detail response was not valid JSON.', retryable: false }
    }

    const fields: DiscoveredField[] = []
    for (const question of body.questions ?? []) {
      for (const field of question.fields ?? []) {
        fields.push({
          providerFieldId: field.name,
          label: question.label,
          semanticKey: classifyFieldLabel(question.label),
          inputType: mapInputType(field.type),
          required: Boolean(question.required ?? field.required),
          allowedOptions: field.values ? field.values.map((v) => v.label) : null,
          confidence: classifyFieldLabel(question.label) ? 0.9 : 0,
        })
      }
    }

    return { outcome: 'clear', fields, domainValidations }
  },

  async submit(request: SubmissionRequest, fields: DiscoveredField[]): Promise<SubmissionResult> {
    const parsed = parseGreenhouseApplyUrl(request.applyUrl)
    if (!parsed) return { outcome: 'failed', reason: 'Apply URL failed re-validation immediately before submission.', retryable: false }

    const submitUrl = `https://${GREENHOUSE_API_HOST}/v1/boards/${encodeURIComponent(parsed.boardToken)}/jobs/${encodeURIComponent(parsed.jobId)}`

    // Safety net: every required field must have a resolved answer before
    // we ever build a request body. This should be unreachable in practice
    // (executor.ts already escalates to NEEDS_HUMAN before calling submit),
    // but submit() never trusts a caller's prior checks for something this
    // consequential.
    const requiredFieldIds = new Set(fields.filter((f) => f.required).map((f) => f.providerFieldId))
    const resolvedFieldIds = new Set(request.answers.filter((a) => a.status === 'resolved').map((a) => a.field.providerFieldId))
    const missing = [...requiredFieldIds].filter((id) => !resolvedFieldIds.has(id))
    if (missing.length > 0) {
      return { outcome: 'failed', reason: `Refusing to submit — required field(s) unresolved at submit time: ${missing.join(', ')}`, retryable: false }
    }

    const form = new FormData()
    const [firstName, ...rest] = request.founder.fullName.trim().split(/\s+/)
    form.set('first_name', firstName ?? '')
    form.set('last_name', rest.join(' ') || firstName || '')
    form.set('email', request.founder.email)
    if (request.founder.phone) form.set('phone', request.founder.phone)
    form.set('resume', new Blob([request.resume.content], { type: 'text/plain' }), 'resume.txt')
    if (request.coverLetter) form.set('cover_letter', new Blob([request.coverLetter], { type: 'text/plain' }), 'cover_letter.txt')
    for (const answer of request.answers) {
      if (answer.status === 'resolved') form.set(answer.field.providerFieldId, answer.value)
    }

    let response: Response
    try {
      // Phase 1: dispatching the request. Any failure here means the
      // request never reached (or was never accepted by) the server —
      // safe to classify as a plain, retryable failure.
      response = await fetch(submitUrl, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      return { outcome: 'failed', reason: `Network failure before submission was dispatched: ${err instanceof Error ? err.message : String(err)}`, retryable: true }
    }

    const domainValidations: DomainValidation[] = [{ url: submitUrl, hostname: GREENHOUSE_API_HOST, allowed: true, reason: 'Fixed, validated Greenhouse API host.' }]
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      // A redirect on the SUBMIT call itself (as opposed to discovery) is
      // never followed — an ATS submission endpoint redirecting somewhere
      // else post-POST is exactly the "employer page redirects elsewhere"
      // scenario the issue calls out, and by the time we're submitting we
      // must not silently hand control to wherever that points.
      return { outcome: 'prohibited_destination', reason: 'Submission response was an unexpected redirect — refusing to follow it.', domainValidations }
    }

    try {
      // Phase 2: reading/interpreting the response. A failure here means
      // the request WAS dispatched and the server responded (or the
      // connection was live when it started responding) — we cannot tell
      // whether the application was actually recorded server-side, so this
      // must never be treated as a plain safe failure.
      const bodyText = await response.text()
      const challenge = detectChallengeSignal(response.status, response.headers.get('content-type'), response.ok ? '' : bodyText)
      if (challenge === 'captcha') return { outcome: 'captcha_detected', reason: 'CAPTCHA/challenge signal detected on submission response.' }
      if (challenge === 'anti_bot') return { outcome: 'anti_bot_detected', reason: 'Anti-bot/challenge response detected on submission.' }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        return { outcome: 'failed', reason: `Greenhouse submission failed: ${response.status} ${bodyText.slice(0, 300)}`, retryable, response: { status: response.status } }
      }

      let parsedBody: Record<string, unknown>
      try {
        parsedBody = JSON.parse(bodyText) as Record<string, unknown>
      } catch {
        // 2xx status but unparseable body: we know the server accepted the
        // connection and returned "success" but we can't extract a
        // confirmation identifier — positive evidence is required, so this
        // is uncertain, never a guessed success.
        return { outcome: 'submission_uncertain', reason: 'Submission response was 2xx but the body was not valid JSON — no confirmation identifier available.', response: { status: response.status } }
      }

      const confirmationId =
        (typeof parsedBody.id === 'number' || typeof parsedBody.id === 'string' ? String(parsedBody.id) : null) ??
        (typeof parsedBody.application_id === 'string' ? parsedBody.application_id : null) ??
        (typeof parsedBody.confirmation_id === 'string' ? parsedBody.confirmation_id : null)

      if (!confirmationId) {
        return { outcome: 'submission_uncertain', reason: '2xx response contained no recognizable confirmation identifier — refusing to claim SUBMITTED without positive evidence.', response: { status: response.status, body: parsedBody } }
      }

      return {
        outcome: 'submitted',
        evidence: { confirmationId, method: 'ats_api_response', receivedAt: new Date().toISOString(), raw: { status: response.status } },
        response: { status: response.status },
      }
    } catch (err) {
      return { outcome: 'submission_uncertain', reason: `Response could not be read after the request was dispatched: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
