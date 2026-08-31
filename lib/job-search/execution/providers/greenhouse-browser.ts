/** Greenhouse applicant-page browser adapter. Never accepts a caller URL. */
import 'server-only'
import crypto from 'node:crypto'
import type { Locator, Page } from 'playwright-core'
import { isAllowedAtsHost } from '../allowed-destinations'
import { validateDestination } from '../ssrf-guard'
import type { DiscoveredField, SubmissionRequest } from '../types'
import { launchServerlessChromium } from './serverless-chromium'

const NAVIGATION_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 45_000
const MAX_ACTIONS = 60

function allowedGreenhouseNavigation(url: string): boolean {
  const safe = validateDestination(url)
  return safe.allowed && isAllowedAtsHost('greenhouse', safe.hostname)
}

function allowedPublicSubresource(url: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true
  const safe = validateDestination(url)
  return safe.allowed
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function regexValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Greenhouse's public questions API exposes a field `name`, but the hosted
 * applicant page does not promise to reuse that value as the DOM control's
 * `name` attribute. Prefer that strongest provider identifier when present,
 * then fall back to browser-native label association. `getByLabel` resolves
 * both explicit label[for]/id pairs and nested labels, which matches the
 * semantics the applicant sees without guessing from nearby text.
 *
 * Every strategy must resolve to exactly one control. We never take `.first()`
 * before counting because doing so would hide an ambiguous match.
 */
async function resolveSingleControl(page: Page, field: DiscoveredField): Promise<{ control: Locator } | { reason: string }> {
  const strategies: { description: string; locator: Locator }[] = [
    {
      description: 'provider field name',
      locator: page.locator(`[name="${cssAttributeValue(field.providerFieldId)}"]`),
    },
    {
      description: 'provider field id',
      locator: page.locator(`[id="${cssAttributeValue(field.providerFieldId)}"]`),
    },
    {
      description: 'accessible label',
      // Greenhouse visually marks required fields with `*`; allow only that
      // decoration and surrounding whitespace around the discovered label.
      locator: page.getByLabel(new RegExp(`^\\s*${regexValue(field.label.trim())}\\s*\\*?\\s*$`, 'i')),
    },
  ]

  const ambiguous: string[] = []
  for (const strategy of strategies) {
    const count = await strategy.locator.count()
    if (count === 1) return { control: strategy.locator }
    if (count > 1) ambiguous.push(`${strategy.description} matched ${count} controls`)
  }

  if (ambiguous.length > 0) {
    return { reason: `Greenhouse exposed ambiguous controls for required field "${field.label}" (${ambiguous.join('; ')}).` }
  }
  return { reason: `Greenhouse did not expose a control for required field "${field.label}" by provider identifier or accessible label.` }
}

function makeResumePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, '\\$&').replace(/\r?\n/g, ') Tj 0 -14 Td (')
  const stream = `BT /F1 10 Tf 54 760 Td (${escaped}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

function challenge(body: string): 'captcha_detected' | 'anti_bot_detected' | null {
  if (/captcha|recaptcha|hcaptcha|turnstile/i.test(body)) return 'captcha_detected'
  if (/checking your browser|bot detection|are you human/i.test(body)) return 'anti_bot_detected'
  return null
}

/**
 * Runs the non-consequential Greenhouse readiness pass.  This module has no
 * submit selector and no click path: keeping dry-run in a submit-capable
 * function made the guarantee depend on a boolean close to the final action.
 * A future live-submission implementation must live in a separately audited
 * module, with its own production-runtime and provider-DOM validation.
 */
export async function runGreenhouseBrowserReadiness(request: SubmissionRequest, fields: DiscoveredField[]): Promise<{ outcome: 'ready' | 'needs_human'; reason: string }> {
  if (!allowedGreenhouseNavigation(request.applyUrl)) return { outcome: 'needs_human', reason: 'Greenhouse applicant page failed destination validation.' }
  let browser: Awaited<ReturnType<typeof launchServerlessChromium>> | undefined
  let context: Awaited<ReturnType<Awaited<ReturnType<typeof launchServerlessChromium>>['newContext']>> | undefined
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
        if (!allowedGreenhouseNavigation(url)) {
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
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Browser execution exceeded its total time limit.')), TOTAL_TIMEOUT_MS) })
    try {
      await Promise.race([page.goto(request.applyUrl, { waitUntil: 'domcontentloaded' }), finish])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (prohibitedNavigation || !allowedGreenhouseNavigation(page.url())) return { outcome: 'needs_human', reason: 'Greenhouse navigation attempted a prohibited redirect.' }
    const body = await page.locator('body').innerText()
    const signal = challenge(body)
    if (signal) return { outcome: 'needs_human', reason: 'Greenhouse applicant page displayed a challenge; automation stopped without bypassing it.' }
    if (/sign in|create account|log in|identity verification/i.test(body)) return { outcome: 'needs_human', reason: 'Greenhouse requested login, account creation, or identity verification; founder action is required.' }

    let actions = 0
    for (const answer of request.answers) {
      if (answer.status !== 'resolved') continue
      const resolution = await resolveSingleControl(page, answer.field)
      if ('reason' in resolution) return { outcome: 'needs_human', reason: resolution.reason }
      const control = resolution.control
      if (++actions > MAX_ACTIONS) return { outcome: 'needs_human', reason: 'Browser action limit reached before submission.' }
      if (answer.field.inputType === 'select') await control.selectOption(answer.value)
      else await control.fill(answer.value)
    }

    const resumeControl = page.locator('input[type="file"]').first()
    if ((await resumeControl.count()) === 0) return { outcome: 'needs_human', reason: 'Greenhouse form has no resume upload control.' }
    const pdf = makeResumePdf(request.resume.content)
    const shortHash = crypto.createHash('sha256').update(pdf).digest('hex').slice(0, 12)
    await resumeControl.setInputFiles({ name: `caye-resume-${shortHash}.pdf`, mimeType: 'application/pdf', buffer: pdf })
    return { outcome: 'ready', reason: 'Dry run completed browser field fill and resume upload; final submit is structurally unavailable.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { outcome: 'needs_human', reason: `Browser readiness check failed: ${message}` }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}
