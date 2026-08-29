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
 * ============================================================================
 * SUBMISSION IS NOT SUPPORTED THROUGH THIS API — VERIFIED 2026-08-29
 * ============================================================================
 * An earlier revision of this file POSTed a multipart application body to
 * boards-api.greenhouse.io. That was wrong, and it is deleted rather than
 * left behind a flag, because the capability does not exist for us:
 *
 *   1. AUTHENTICATION. Greenhouse's own docs are explicit that the GETs are
 *      public but the submission POST is not: "Job Board data is publicly
 *      available, so authentication is not required for any GET endpoints"
 *      — only the POST "requires HTTP Basic Auth over SSL/TLS: the Basic
 *      Auth username is your API key (found on the API Credentials page)."
 *      That key is the EMPLOYER's Job Board API key, issued inside their
 *      Greenhouse account. It exists so an employer can power their OWN
 *      career-site form. An outside applicant cannot hold it for an
 *      arbitrary employer, and must not try to. The deleted code sent no
 *      Authorization header at all, so every real attempt would have been
 *      rejected — the "unverified wire format" the PR originally flagged was
 *      not merely unverified, it was unusable.
 *
 *   2. NO SERVER-SIDE VALIDATION TO RELY ON. Greenhouse further documents
 *      that it "will not confirm the inclusion of required fields" and
 *      "will not reject applications that are missing required fields."
 *      So even with a key, a 2xx would not be evidence of a complete or
 *      correct application — exactly the positive-evidence property the
 *      SUBMITTED transition depends on.
 *
 *   3. GREENHOUSE'S OWN GUIDANCE is to use their Embedded Job Application
 *      rather than a custom form, citing their built-in spam/abuse
 *      protections.
 *
 * What remains here is `discoverFields`, which uses only the PUBLIC,
 * read-only GET and is genuinely verified: the parsing below was checked
 * against a live public board (gitlab, job 8503792002) on 2026-08-29.
 * Discovery is what makes the prepare/readiness report real. `submit`
 * unconditionally refuses and performs no network call whatsoever.
 *
 * Making real submission possible is a PRODUCT decision, not a wire-format
 * fix: it needs a lawful authenticated channel (an employer-granted key, an
 * official partner integration, or an explicitly-consented browser session
 * driven by the founder). Until one exists, this provider prepares and
 * escalates — it never submits.
 */
import type { AtsExecutorProvider } from './types'
import type { DiscoveredField, FieldDiscoveryResult, SubmissionResult } from '../types'
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

/**
 * Verified against a live public board on 2026-08-29: `values[].value` is a
 * NUMBER on real boards (e.g. `{"label":"No","value":239207523002}`), and is
 * sometimes a small ordinal instead (`{"label":"No","value":0}`) on the same
 * board for a different question. It is typed loosely here and normalized to
 * a string exactly once, below.
 */
type GreenhouseQuestionField = { name: string; type: string; required?: boolean; values?: { label: string; value: string | number }[] }
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

/**
 * Detects a challenge/anti-bot response even though we expect clean JSON.
 * Never used to bypass anything — only to decide whether to escalate.
 *
 * The `|| lowerBody.length > 0` clause this originally ended with made the
 * whole pattern list decorative: ANY non-JSON 403/503 carrying ANY body at
 * all was reported as a bot challenge. An ordinary 403 (job closed, board
 * disabled, application window ended) is a normal, meaningful answer from
 * Greenhouse and must be reported as itself, not dressed up as anti-bot
 * evasion. Only a real challenge fingerprint counts.
 */
function detectChallengeSignal(status: number, contentType: string | null, bodyText: string): 'captcha' | 'anti_bot' | null {
  const lowerBody = bodyText.toLowerCase()
  if (/captcha|recaptcha|hcaptcha|turnstile/.test(lowerBody)) return 'captcha'
  if ((status === 403 || status === 503) && (!contentType || !contentType.includes('application/json'))) {
    if (/cloudflare|checking your browser|access denied|are you human|bot detection|ddos protection|ray id|challenge-platform/.test(lowerBody)) {
      return 'anti_bot'
    }
  }
  return null
}

export const greenhouseAtsProvider: AtsExecutorProvider = {
  providerKey: 'greenhouse',

  /** See the module header. Greenhouse's public API has no applicant-usable submission channel. */
  canSubmit: false,

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
          allowedOptions: field.values && field.values.length > 0 ? field.values.map((v) => ({ label: v.label, value: String(v.value) })) : null,
          confidence: classifyFieldLabel(question.label) ? 0.9 : 0,
        })
      }
    }

    return { outcome: 'clear', fields, domainValidations }
  },

  /**
   * Unconditionally refuses. Performs NO network request of any kind.
   *
   * See this module's header: Greenhouse's application-submission endpoint
   * requires the employer's own Job Board API key as HTTP Basic Auth, which
   * we cannot lawfully hold for an arbitrary employer. There is deliberately
   * no flag, setting, or rollout switch that turns this into a real POST —
   * the request-building code was deleted rather than disabled, so no future
   * config change can resurrect an unauthenticated submission attempt.
   */
  async submit(): Promise<SubmissionResult> {
    return {
      outcome: 'not_supported',
      reason:
        "Greenhouse's application-submission endpoint requires the employer's own Job Board API key (HTTP Basic Auth); only the read-only job and question endpoints are public. Caye cannot hold that key for an employer, so it never attempts a submission.",
    }
  },
}
