/**
 * Job-search operator (CAY-194 / #194) — placeholder for providers this PR
 * conceptually supports (via the AtsExecutorProvider interface) but does
 * not implement: Ashby, Workday-style systems, and generic employer forms.
 * Lever had this same status until the Lever provider-coverage PR gave it
 * a real DOM-based executor — see providers/lever.ts and
 * providers/lever-form-session.ts.
 *
 * Always escalates to human review, never guesses, never falls through to
 * an implicit "try something." preflight.ts's `deriveProvider` only ever
 * produces 'greenhouse', 'lever', or 'generic' today, and its
 * `provider_supported` check refuses execution for anything outside
 * {greenhouse, lever} before a claim is ever taken — so in practice this
 * provider is never actually invoked. It exists so the provider-neutral
 * interface always has a safe fallback implementation for any
 * ExecutionProvider value without its own executor, and so a future
 * provider addition (Ashby, Workday) has a template to extend.
 */
import type { AtsExecutorProvider } from './types'

export function unsupportedProvider(providerKey: string): AtsExecutorProvider {
  return {
    providerKey,
    canSubmit: false,
    async discoverFields() {
      return { outcome: 'unsupported_provider', reason: `No automated executor exists for provider "${providerKey}" yet — human review required.` }
    },
    async submit() {
      return { outcome: 'not_supported', reason: `No automated executor exists for provider "${providerKey}" — submit() should never be called for it.` }
    },
  }
}
