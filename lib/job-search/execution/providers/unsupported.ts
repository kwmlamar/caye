/**
 * Job-search operator (CAY-194 / #194) — placeholder for providers this PR
 * conceptually supports (via the AtsExecutorProvider interface) but does
 * not implement: Lever, Ashby, Workday-style systems, and generic employer
 * forms. Lever in particular has no documented public write API (its
 * postings API is read-only — see lib/job-search/sources/lever.ts), so an
 * automated Lever executor would require real browser automation against
 * jobs.lever.co's hosted form, deliberately out of scope for this PR (see
 * PR description's provider-selection rationale).
 *
 * Always escalates to human review, never guesses, never falls through to
 * an implicit "try something." executor.ts's preflight already refuses to
 * claim an application whose derived provider isn't in this list at all,
 * so in practice this provider is never actually invoked today — it exists
 * so the provider-neutral interface has a real second implementation to
 * prove the abstraction isn't Greenhouse-shaped by accident, and so a
 * future provider addition has a template to extend.
 */
import type { AtsExecutorProvider } from './types'

export function unsupportedProvider(providerKey: string): AtsExecutorProvider {
  return {
    providerKey,
    async discoverFields() {
      return { outcome: 'unsupported_provider', reason: `No automated executor exists for provider "${providerKey}" yet — human review required.` }
    },
    async submit() {
      return { outcome: 'failed', reason: `No automated executor exists for provider "${providerKey}" — submit() should never be called for it.`, retryable: false }
    },
  }
}
