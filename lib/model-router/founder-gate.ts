import 'server-only'
import { isFounderUserId } from '@/lib/founder'
import type { FounderRouterContext } from './types'

/**
 * Deterministic, code-enforced boundary: subscription-backed backends
 * (claude_subscription, openai_codex_subscription) and this router in
 * general must be unreachable from anything that isn't a founder-authored
 * Caye Direct request — customers, webhooks, cron, other operators.
 *
 * Per [[caye_prompt_rules_need_code_enforcement]]: irreversible/high-trust
 * surfaces get a check in code, not just a route that happens to be under
 * app/api/founder/. This function is the single choke point every call
 * site (route handler, background job, whatever) must pass through before
 * touching lib/model-router. It throws rather than returning a boolean so
 * a call site can't accidentally ignore a false.
 */
export class FounderRouterAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FounderRouterAccessError'
  }
}

export function assertFounderRouterAccess(
  ctx: FounderRouterContext | null | undefined
): asserts ctx is FounderRouterContext {
  if (!ctx) {
    throw new FounderRouterAccessError(
      'model-router: no FounderRouterContext supplied — this surface requires a founder-authenticated caller'
    )
  }
  if (!ctx.founderUserId || !isFounderUserId(ctx.founderUserId)) {
    throw new FounderRouterAccessError(
      `model-router: founderUserId "${ctx.founderUserId ?? ''}" is not on the founder allowlist`
    )
  }
  if (!ctx.threadId) {
    throw new FounderRouterAccessError(
      'model-router: threadId is required — this router is Caye Direct thread-scoped only, not a general-purpose entry point'
    )
  }
}
