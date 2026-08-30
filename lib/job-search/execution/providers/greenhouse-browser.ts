/** Greenhouse applicant-page browser adapter. Never accepts a caller URL. */
import 'server-only'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { isAllowedAtsHost } from '../allowed-destinations'
import { validateDestination } from '../ssrf-guard'
import type { DiscoveredField, SubmissionRequest, SubmissionResult } from '../types'

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

export async function submitGreenhouseInBrowser(request: SubmissionRequest, fields: DiscoveredField[]): Promise<SubmissionResult> {
  if (!allowedGreenhouseNavigation(request.applyUrl)) return { outcome: 'prohibited_destination', reason: 'Greenhouse applicant page failed destination validation.', domainValidations: [] }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>> | undefined
  let submitClicked = false
  try {
    browser = await chromium.launch({ headless: true })
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
    const finish = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser execution exceeded its total time limit.')), TOTAL_TIMEOUT_MS))
    await Promise.race([page.goto(request.applyUrl, { waitUntil: 'domcontentloaded' }), finish])
    if (prohibitedNavigation || !allowedGreenhouseNavigation(page.url())) return { outcome: 'prohibited_destination', reason: 'Greenhouse navigation attempted a prohibited redirect.', domainValidations: [] }
    const body = await page.locator('body').innerText()
    const signal = challenge(body)
    if (signal) return { outcome: signal, reason: 'Greenhouse applicant page displayed a challenge; automation stopped without bypassing it.' }
    if (/sign in|create account|log in|identity verification/i.test(body)) return { outcome: 'failed', retryable: false, reason: 'Greenhouse requested login, account creation, or identity verification; founder action is required.' }

    let actions = 0
    for (const answer of request.answers) {
      if (answer.status !== 'resolved') continue
      const selector = `[name="${cssAttributeValue(answer.field.providerFieldId)}"]`
      const control = page.locator(selector).first()
      if ((await control.count()) === 0) continue
      if (++actions > MAX_ACTIONS) return { outcome: 'failed', retryable: false, reason: 'Browser action limit reached before submission.' }
      if (answer.field.inputType === 'select') await control.selectOption(answer.value)
      else await control.fill(answer.value)
    }

    const resumeControl = page.locator('input[type="file"]').first()
    if ((await resumeControl.count()) === 0) return { outcome: 'failed', retryable: false, reason: 'Greenhouse form has no resume upload control.' }
    const pdf = makeResumePdf(request.resume.content)
    const shortHash = crypto.createHash('sha256').update(pdf).digest('hex').slice(0, 12)
    await resumeControl.setInputFiles({ name: `caye-resume-${shortHash}.pdf`, mimeType: 'application/pdf', buffer: pdf })
    if (request.dryRun) return { outcome: 'failed', retryable: false, reason: 'Dry run completed browser field fill and resume upload; final submit was intentionally not invoked.' }

    const submit = page.locator('button[type="submit"]:has-text("Submit"), input[type="submit"][value*="Submit" i]').first()
    if ((await submit.count()) === 0) return { outcome: 'failed', retryable: false, reason: 'No provider-recognized Greenhouse submit control was found.' }
    submitClicked = true
    await submit.click()
    try { await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }) } catch { return { outcome: 'submission_uncertain', reason: 'Submit was clicked but navigation confirmation timed out.' } }
    if (prohibitedNavigation || !allowedGreenhouseNavigation(page.url())) return { outcome: 'submission_uncertain', reason: 'Submit was clicked but the confirmation navigation was prohibited or ambiguous.' }
    const confirmation = page.locator('#application_confirmation, [data-testid="application-confirmation"]').first()
    if ((await confirmation.count()) === 0) return { outcome: 'submission_uncertain', reason: 'Submit was clicked but no Greenhouse-specific confirmation element was observed.' }
    const confirmationText = (await confirmation.innerText()).trim().slice(0, 500)
    const confirmationId = crypto.createHash('sha256').update(`${request.applicationId}:${page.url()}:${confirmationText}`).digest('hex').slice(0, 24)
    return { outcome: 'submitted', evidence: { confirmationId, method: 'browser_confirmation', receivedAt: new Date().toISOString(), raw: { finalUrl: page.url(), confirmationSelector: '#application_confirmation' } }, response: { finalUrl: page.url() } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (submitClicked) return { outcome: 'submission_uncertain', reason: `Browser failed after the submit action: ${message}` }
    return { outcome: 'failed', retryable: false, reason: `Browser failed before any submit action: ${message}` }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}
