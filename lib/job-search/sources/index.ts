/**
 * Job-search operator (#192) — source adapter registry.
 *
 * Deliberately closed, like CRON_JOBS (lib/caye-agent/tools/admin/cron-
 * registry.ts) and the CAY-27 capability catalog: adding a source means
 * writing an adapter file and registering it here, never something
 * driven dynamically by config alone. There is intentionally no
 * 'linkedin' or 'indeed' entry — see policy-gate.ts's
 * isProhibitedApplyDestination, which is the second, independent
 * enforcement point even if a future adapter ever produced a posting
 * whose apply_url happened to resolve to one of those domains.
 */
import 'server-only'
import { greenhouseAdapter } from './greenhouse'
import { leverAdapter } from './lever'
import type { SourceAdapter } from './types'

export const SOURCE_ADAPTERS: Record<string, SourceAdapter> = {
  greenhouse_public: greenhouseAdapter,
  lever_public: leverAdapter,
}

export function getSourceAdapter(sourceKey: string): SourceAdapter | null {
  return SOURCE_ADAPTERS[sourceKey] ?? null
}

export type { SourceAdapter } from './types'
