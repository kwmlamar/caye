/**
 * The sole browser launcher for job-search readiness checks.
 *
 * This uses the Linux Chromium archive shipped by `@sparticuz/chromium`; it
 * never consults Playwright's local browser cache and accepts no caller path.
 * The package expands its own bundled archive into the function's ephemeral
 * /tmp directory.
 */
import 'server-only'
import chromium from '@sparticuz/chromium'
import { chromium as playwrightChromium, type Browser } from 'playwright-core'

export const SERVERLESS_CHROMIUM_PACKAGE = '@sparticuz/chromium'

export async function launchServerlessChromium(): Promise<Browser> {
  chromium.setGraphicsMode = false
  const executablePath = await chromium.executablePath()
  if (!executablePath.startsWith('/tmp/')) {
    throw new Error('Serverless Chromium did not resolve to the function ephemeral runtime.')
  }
  return playwrightChromium.launch({ args: chromium.args, executablePath, headless: true })
}
