import 'server-only'
import { runChainWithFallback, DEFAULT_ROUTER_POLICY, type RouterPolicy } from '../router'
import type { BackendId, RequestedMode, RouterDecision } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from './types'

/**
 * Tool-turn analog of router.ts's runWithFallback, sharing the exact same
 * chain-walk (runChainWithFallback) so Auto's health-check/classify/
 * fallback behavior is identical whether founder-tool-loop.ts is asking
 * for a plain answer or a tool-capable round. The only difference is which
 * backend method gets called.
 *
 * `restrictToChain`: passed by founder-tool-loop.ts once a write tool has
 * been attempted this turn — pins every subsequent round to the single
 * backend that served the write, so a later round's reasoning failure
 * cannot cause a silent switch to a different provider mid-transaction.
 * See founder-tool-loop.ts's `writeAttempted` handling.
 */
export async function runToolTurnWithFallback(
  backends: readonly ToolCapableBackend[],
  requestedMode: RequestedMode,
  req: ToolTurnRequest,
  signal: AbortSignal,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
  restrictToChain?: BackendId[]
): Promise<{ result: ToolTurnResult; decision: RouterDecision }> {
  return runChainWithFallback(
    backends,
    requestedMode,
    req.hints,
    (backend, s) => (backend as ToolCapableBackend).invokeTurn(req, s),
    signal,
    policy,
    restrictToChain
  )
}
