/**
 * Lever hosted-form browser session — field discovery AND non-consequential
 * fill share this module for the same reason greenhouse-form-session.ts
 * exists: one audited implementation of navigation, destination
 * revalidation, and challenge detection, never two that can drift.
 *
 * Lever has no public field-discovery API analogous to Greenhouse's
 * `?questions=true` Job Board endpoint (see lib/job-search/sources/lever.ts
 * — its public postings feed is read-only and carries no application-form
 * metadata). Discovery here is therefore DOM-based: it opens the real
 * jobs.lever.co apply page and reads the same `li.application-question`
 * structure a human applicant sees, verified against two unrelated live
 * employer boards on 2026-08-31 (mashgin, bfsaul).
 *
 * That same verification found Lever's hosted template embeds an hCaptcha
 * widget (`.h-captcha` + the hcaptcha script) on every board checked, with
 * a hidden `h-captcha-response` field the backend requires to accept a
 * submission. This module treats that widget's mere presence as a
 * captcha_detected challenge signal, unconditionally — never attempted,
 * never worked around. That is why lever.ts sets `canSubmit: false`: this
 * module still fully discovers and prepares an application, but has no
 * lawful path past the captcha to a real submit click.
 *
 * This module has no submit selector and no click path, exactly like
 * greenhouse-form-session.ts — Lever has none today (canSubmit: false), but
 * the separation is the same discipline regardless: the non-consequential
 * half stays incapable of the consequential action even if that ever
 * changes.
 */
import 'server-only'
import crypto from 'node:crypto'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { isAllowedAtsHost } from '../allowed-destinations'
import { validateDestination } from '../ssrf-guard'
import { classifyFieldLabel } from '../field-classifier'
import type { DiscoveredField, FieldDiscoveryResult, SubmissionRequest } from '../types'
import { launchServerlessChromium } from './serverless-chromium'
import { makeResumePdf } from './greenhouse-form-session'

export const NAVIGATION_TIMEOUT_MS = 20_000
export const TOTAL_TIMEOUT_MS = 45_000
const MAX_ACTIONS = 60

export function allowedLeverNavigation(url: string): boolean {
  const safe = validateDestination(url)
  return safe.allowed && isAllowedAtsHost('lever', safe.hostname)
}

function allowedPublicSubresource(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true
  const safe = validateDestination(url)
  return safe.allowed
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Lever posting/apply URLs are always `/{site}/{postingId}(/apply)?` where postingId is a UUID. */
export function parseLeverApplyUrl(applyUrl: string): { site: string; postingId: string } | null {
  let url: URL
  try {
    url = new URL(applyUrl)
  } catch {
    return null
  }
  if (!isAllowedAtsHost('lever', url.hostname)) return null
  const match = url.pathname.match(/^\/([^/]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/)
  if (!match) return null
  return { site: match[1], postingId: match[2] }
}

export function challenge(bodyText: string, hCaptchaWidgetPresent: boolean): 'captcha_detected' | 'anti_bot_detected' | null {
  if (hCaptchaWidgetPresent) return 'captcha_detected'
  if (/captcha|recaptcha|hcaptcha|turnstile/i.test(bodyText)) return 'captcha_detected'
  if (/checking your browser|bot detection|are you human|access denied|ray id|challenge-platform/i.test(bodyText)) return 'anti_bot_detected'
  return null
}

export function requiresIdentity(bodyText: string): boolean {
  return /sign in|create account|log in|identity verification/i.test(bodyText)
}

/** Raw shape read directly off the live DOM by `page.evaluate` — see extractionScript below. */
export type RawLeverBlock = {
  label: string
  required: boolean
  controls: { tag: string; type: string | null; name: string | null; required: boolean; value: string | null }[]
  selectOptions: { label: string; value: string }[]
}

/**
 * Runs inside the browser page. Deliberately plain, dependency-free DOM
 * reading — no assumptions beyond the structure verified live: each
 * question is one `li.application-question`, its label lives in
 * `.application-label` (optionally nested in a `.text` child for
 * multi-line templates), and Lever marks a required question with a
 * `.required` marker element rather than a reliable native `required`
 * attribute (confirmed live: the resume question has no native
 * `required` attribute at all, only the marker).
 */
export function leverExtractionScript(): RawLeverBlock[] {
  const blocks: RawLeverBlock[] = []
  document.querySelectorAll('form#application-form li.application-question').forEach((li) => {
    const labelEl = li.querySelector('.application-label')
    const textEl = labelEl?.querySelector('.text') ?? labelEl
    const label = (textEl?.textContent ?? '').replace(/[✱*]/g, '').trim()
    const requiredMarker = !!li.querySelector('.application-label .required')

    const controls: RawLeverBlock['controls'] = []
    li.querySelectorAll('input, select, textarea').forEach((el) => {
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      controls.push({
        tag: input.tagName,
        type: 'type' in input ? (input as HTMLInputElement).type || null : null,
        name: input.name || null,
        required: input.required || input.getAttribute('aria-required') === 'true',
        value: input.tagName === 'SELECT' ? null : (input as HTMLInputElement).value || null,
      })
    })

    const selectOptions: RawLeverBlock['selectOptions'] = []
    li.querySelectorAll('select option').forEach((opt) => {
      const option = opt as HTMLOptionElement
      if (option.value) selectOptions.push({ label: (option.textContent ?? '').trim(), value: option.value })
    })

    blocks.push({ label, required: requiredMarker, controls, selectOptions })
  })
  return blocks
}

/** Pure mapping from the raw DOM read to provider-neutral fields — the part unit tests exercise directly, no browser required. */
export function mapRawLeverBlocksToFields(blocks: RawLeverBlock[]): DiscoveredField[] {
  const fields: DiscoveredField[] = []
  for (const block of blocks) {
    const visible = block.controls.filter((c) => c.type !== 'hidden')
    if (visible.length === 0) continue
    const primary = visible[0]
    if (!primary.name) continue

    const required = block.required || visible.some((c) => c.required)
    const semanticKey = classifyFieldLabel(block.label)

    let inputType: DiscoveredField['inputType'] = 'unknown'
    let allowedOptions: DiscoveredField['allowedOptions'] = null
    if (primary.tag === 'SELECT') {
      inputType = 'select'
      allowedOptions = block.selectOptions.length > 0 ? block.selectOptions : null
    } else if (primary.type === 'file') {
      inputType = 'file'
    } else if (primary.tag === 'TEXTAREA') {
      inputType = 'textarea'
    } else if (primary.type === 'radio') {
      inputType = 'select'
      allowedOptions = dedupeOptions(visible.filter((c) => c.type === 'radio' && c.value))
    } else if (primary.type === 'checkbox') {
      inputType = 'multi_select'
      allowedOptions = dedupeOptions(visible.filter((c) => c.type === 'checkbox' && c.value))
    } else {
      inputType = 'text'
    }

    fields.push({
      providerFieldId: primary.name,
      label: block.label,
      semanticKey,
      inputType,
      required,
      allowedOptions,
      confidence: semanticKey ? 0.9 : 0,
    })
  }
  return fields
}

function dedupeOptions(controls: { value: string | null }[]): { label: string; value: string }[] {
  const seen = new Set<string>()
  const options: { label: string; value: string }[] = []
  for (const c of controls) {
    if (!c.value || seen.has(c.value)) continue
    seen.add(c.value)
    // Verified live (mashgin, 2026-08-31): Lever's radio/checkbox `value`
    // attribute IS the exact visible option text, unlike Greenhouse where
    // the wire value is an opaque numeric id — so label and value are the
    // same string here, not an approximation.
    options.push({ label: c.value, value: c.value })
  }
  return options
}

type OpenSessionResult =
  | { outcome: 'open'; page: Page; close: () => Promise<void> }
  | { outcome: 'blocked'; reason: 'prohibited_destination' | 'captcha_detected' | 'anti_bot_detected' | 'identity_required' | 'form_not_found' | 'error'; detail: string }

/** Opens the Lever applicant page and runs every safety check shared by discovery and fill. Caller owns the returned page on 'open' and MUST call close(). */
async function openLeverSession(applyUrl: string): Promise<OpenSessionResult> {
  if (!allowedLeverNavigation(applyUrl)) return { outcome: 'blocked', reason: 'prohibited_destination', detail: 'Lever applicant page failed destination validation.' }

  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const close = async () => {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }

  try {
    browser = await launchServerlessChromium()
    context = await browser.newContext({ storageState: undefined, acceptDownloads: false })
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS)

    let prohibitedNavigation = false
    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = req.url()
      if (req.isNavigationRequest()) {
        if (!allowedLeverNavigation(url)) {
          prohibitedNavigation = true
          await route.abort('blockedbyclient')
          return
        }
      } else if (!allowedPublicSubresource(url)) {
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })

    context.on('page', (extra) => { if (extra !== page) extra.close().catch(() => undefined) })

    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser execution exceeded its total time limit.')), TOTAL_TIMEOUT_MS) })
    try {
      await Promise.race([page.goto(applyUrl, { waitUntil: 'domcontentloaded' }), finish])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    if (prohibitedNavigation || !allowedLeverNavigation(page.url())) {
      await close()
      return { outcome: 'blocked', reason: 'prohibited_destination', detail: 'Lever navigation attempted a prohibited redirect.' }
    }

    const body = await page.locator('body').innerText()
    const hCaptchaPresent = (await page.locator('.h-captcha').count()) > 0
    const signal = challenge(body, hCaptchaPresent)
    if (signal === 'captcha_detected') {
      await close()
      return { outcome: 'blocked', reason: 'captcha_detected', detail: "Lever's hosted application form requires solving an hCaptcha challenge — automation stopped without attempting it." }
    }
    if (signal === 'anti_bot_detected') {
      await close()
      return { outcome: 'blocked', reason: 'anti_bot_detected', detail: 'Lever applicant page displayed an anti-bot challenge; automation stopped without bypassing it.' }
    }
    if (requiresIdentity(body)) {
      await close()
      return { outcome: 'blocked', reason: 'identity_required', detail: 'Lever requested login, account creation, or identity verification; founder action is required.' }
    }

    if ((await page.locator('form#application-form').count()) !== 1) {
      await close()
      return { outcome: 'blocked', reason: 'form_not_found', detail: 'Lever applicant page did not expose exactly one recognizable application form.' }
    }

    return { outcome: 'open', page, close }
  } catch (error) {
    await close()
    return { outcome: 'blocked', reason: 'error', detail: `Lever session failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Deterministic field discovery over the real Lever apply page. Never guesses a field's meaning — unmapped labels come back with `semanticKey: null`. */
export async function discoverLeverFields(applyUrl: string): Promise<FieldDiscoveryResult> {
  const parsed = parseLeverApplyUrl(applyUrl)
  if (!parsed) return { outcome: 'malformed_url', reason: 'Apply URL is not a recognizable Lever apply URL (expected /{site}/{postingId}).' }

  const session = await openLeverSession(applyUrl)
  if (session.outcome === 'blocked') {
    if (session.reason === 'prohibited_destination') return { outcome: 'prohibited_destination', domainValidations: [validateDestinationRecord(applyUrl)], reason: session.detail }
    if (session.reason === 'captcha_detected') return { outcome: 'captcha_detected', domainValidations: [validateDestinationRecord(applyUrl)], reason: session.detail }
    if (session.reason === 'anti_bot_detected') return { outcome: 'anti_bot_detected', domainValidations: [validateDestinationRecord(applyUrl)], reason: session.detail }
    return { outcome: 'discovery_failed', reason: session.detail, retryable: session.reason === 'error' }
  }

  try {
    const raw = (await session.page.evaluate(leverExtractionScript)) as RawLeverBlock[]
    const fields = mapRawLeverBlocksToFields(raw)
    return { outcome: 'clear', fields, domainValidations: [validateDestinationRecord(applyUrl)] }
  } catch (error) {
    return { outcome: 'discovery_failed', reason: `Lever field extraction failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true }
  } finally {
    await session.close()
  }
}

function validateDestinationRecord(url: string): { url: string; hostname: string | null; allowed: boolean; reason: string } {
  const result = validateDestination(url)
  return { url, hostname: result.hostname, allowed: result.allowed, reason: result.allowed ? 'Destination validated.' : result.reason }
}

/** A prepared, filled Lever form. Holds the live page; the caller must always call close(). */
export type LeverFormSession = { page: Page; resumeSha256: string; close: () => Promise<void> }
export type PrepareLeverFormResult = { outcome: 'prepared'; session: LeverFormSession } | { outcome: 'needs_human'; reason: string }

/**
 * Fills one resolved answer into its Lever control. Deterministic and
 * conservative: resolves by exact `name`, and for a name shared by several
 * controls (a radio/checkbox group) additionally requires the resolved
 * value to match exactly one of them. Zero or multiple matches at either
 * step is a refusal, never a guess.
 */
async function fillOneAnswer(page: Page, providerFieldId: string, value: string): Promise<{ ok: true } | { reason: string }> {
  const named = page.locator(`[name="${cssAttributeValue(providerFieldId)}"]`)
  const count = await named.count()
  if (count === 0) return { reason: `Lever did not expose a control named "${providerFieldId}".` }

  if (count === 1) {
    const tag = await named.evaluate((el) => el.tagName)
    if (tag === 'SELECT') {
      await named.selectOption(value)
    } else {
      await named.fill(value)
    }
    return { ok: true }
  }

  // Shared name across multiple controls: a radio or checkbox group.
  const target = page.locator(`[name="${cssAttributeValue(providerFieldId)}"][value="${cssAttributeValue(value)}"]`)
  const targetCount = await target.count()
  if (targetCount !== 1) return { reason: `Lever exposed ${targetCount} controls named "${providerFieldId}" with value "${value}"; refusing to guess which one to select.` }
  await target.check()
  return { ok: true }
}

/**
 * Opens the Lever applicant page and brings it to a fully-filled,
 * ready-to-submit state WITHOUT submitting. Mirrors
 * prepareGreenhouseForm's contract exactly: on any non-'prepared' outcome
 * the browser is already closed; on 'prepared' the caller owns the session.
 */
export async function prepareLeverForm(request: SubmissionRequest, _fields: DiscoveredField[]): Promise<PrepareLeverFormResult> {
  const session = await openLeverSession(request.applyUrl)
  if (session.outcome === 'blocked') return { outcome: 'needs_human', reason: session.detail }

  const { page, close } = session
  try {
    let actions = 0
    for (const answer of request.answers) {
      if (answer.status !== 'resolved') continue
      if (++actions > MAX_ACTIONS) {
        await close()
        return { outcome: 'needs_human', reason: 'Browser action limit reached before submission.' }
      }
      const filled = await fillOneAnswer(page, answer.field.providerFieldId, answer.value)
      if ('reason' in filled) {
        await close()
        return { outcome: 'needs_human', reason: filled.reason }
      }
    }

    const resumeControl = page.locator('input[type="file"]').first()
    if ((await resumeControl.count()) === 0) {
      await close()
      return { outcome: 'needs_human', reason: 'Lever form has no resume upload control.' }
    }
    const pdf = makeResumePdf(request.resume.content)
    const resumeSha256 = crypto.createHash('sha256').update(pdf).digest('hex')
    await resumeControl.setInputFiles({ name: `caye-resume-${resumeSha256.slice(0, 12)}.pdf`, mimeType: 'application/pdf', buffer: pdf })

    return { outcome: 'prepared', session: { page, resumeSha256, close } }
  } catch (error) {
    await close()
    return { outcome: 'needs_human', reason: `Browser readiness check failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
