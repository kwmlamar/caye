/**
 * Job-search operator (CAY-194 / #194) — provider-neutral executor
 * interface. Every ATS provider (Greenhouse today; Lever/Ashby/Workday/
 * generic-forms conceptually, via unsupported.ts, until each gets its own
 * implementation) implements exactly this shape. executor.ts never branches
 * on provider identity outside of `selectProvider` — no provider-specific
 * logic leaks into the orchestrator.
 */
import type { DiscoveredField, FieldDiscoveryResult, SubmissionRequest, SubmissionResult } from '../types'

export interface AtsExecutorProvider {
  readonly providerKey: string
  /** Deterministically discovers the ATS's required application fields for one apply URL. Never guesses; escalates on anything ambiguous. */
  discoverFields(applyUrl: string): Promise<FieldDiscoveryResult>
  /**
   * True only for a provider that has a lawful, authenticated, verified way
   * to submit. This is a compile-time-visible property of the provider
   * itself, NOT a runtime setting — the executor refuses to call submit()
   * unless it is true, so "can we submit at all" can never be turned on by
   * flipping a database flag. No provider sets it to true today; see
   * greenhouse.ts for why Greenhouse's public API cannot.
   */
  readonly canSubmit: boolean
  /**
   * Submits the application. Only ever called after discoverFields returned
   * 'clear', every required field resolved, AND `canSubmit` is true.
   * A provider without a lawful submission channel returns
   * `{ outcome: 'not_supported' }` and performs no network call.
   */
  submit(request: SubmissionRequest, fields: DiscoveredField[]): Promise<SubmissionResult>
}
