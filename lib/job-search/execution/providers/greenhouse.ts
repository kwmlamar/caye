import type { AtsExecutorProvider } from './types'
import type { DiscoveredField, FieldDiscoveryResult, SubmissionResult } from '../types'
import { safeFetch } from '../safe-fetch'
import { isAllowedAtsHost } from '../allowed-destinations'
import { classifyFieldLabel } from '../field-classifier'
import { runGreenhouseBrowserReadiness } from './greenhouse-browser'
import { submitGreenhouseApplication, type FinalAuthorityCheck, type LiveSubmissionTelemetry } from './greenhouse-submit'

const GREENHOUSE_API_HOST = 'boards-api.greenhouse.io'
const GREENHOUSE_EU_API_HOST = 'boards-api.eu.greenhouse.io'
const REQUEST_TIMEOUT_MS = 15_000

type ParsedGreenhouseUrl = { boardToken: string; jobId: string; apiHost: string }

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
  const apiHost = url.hostname.toLowerCase().includes('.eu.greenhouse.io')
    ? GREENHOUSE_EU_API_HOST
    : GREENHOUSE_API_HOST
  return { boardToken: match[1], jobId: match[2], apiHost }
}

function isGreenhouseHost(hostname: string): boolean {
  return isAllowedAtsHost('greenhouse', hostname)
}

type GreenhouseQuestionField = {
  name: string
  type: string
  required?: boolean
  values?: { label: string; value: string | number }[]
}
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
  canSubmit: true,

  async dryRun(request, fields) {
    return runGreenhouseBrowserReadiness(request, fields)
  },

  async discoverFields(applyUrl: string): Promise<FieldDiscoveryResult> {
    const parsed = parseGreenhouseApplyUrl(applyUrl)
    if (!parsed) {
      return {
        outcome: 'malformed_url',
        reason: 'Apply URL is not a recognizable Greenhouse job URL (expected /{board}/jobs/{id}).',
      }
    }

    const discoveryUrl = `https://${parsed.apiHost}/v1/boards/${encodeURIComponent(parsed.boardToken)}/jobs/${encodeURIComponent(parsed.jobId)}?questions=true`

    let result
    try {
      result = await safeFetch(
        discoveryUrl,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        isGreenhouseHost,
      )
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
    if (challenge === 'captcha') {
      return { outcome: 'captcha_detected', domainValidations, reason: 'CAPTCHA/challenge signal detected in Greenhouse response.' }
    }
    if (challenge === 'anti_bot') {
      return { outcome: 'anti_bot_detected', domainValidations, reason: 'Anti-bot/challenge response detected from Greenhouse.' }
    }

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
        const semanticKey = classifyFieldLabel(question.label)
        fields.push({
          providerFieldId: field.name,
          label: question.label,
          semanticKey,
          inputType: mapInputType(field.type),
          required: Boolean(question.required ?? field.required),
          allowedOptions: field.values?.length
            ? field.values.map((value) => ({ label: value.label, value: String(value.value) }))
            : null,
          confidence: semanticKey ? 0.9 : 0,
        })
      }
    }

    return { outcome: 'clear', fields, domainValidations }
  },

  async submit(): Promise<SubmissionResult> {
    return {
      outcome: 'not_supported',
      reason: 'Greenhouse live submission must be invoked through submitLive() with a final authority check. The provider-neutral submit() entry point performs no action.',
    }
  },

  async submitLive(request, fields, finalCheck: FinalAuthorityCheck): Promise<{ result: SubmissionResult; telemetry: LiveSubmissionTelemetry }> {
    return submitGreenhouseApplication(request, fields, finalCheck)
  },
}
