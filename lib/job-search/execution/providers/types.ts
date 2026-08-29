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
  /** Submits the application. Only ever called after discoverFields returned 'clear' and every required field resolved. */
  submit(request: SubmissionRequest, fields: DiscoveredField[]): Promise<SubmissionResult>
}
