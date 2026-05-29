import 'server-only'
import type { OperatorIntent } from '../intent'
import type { PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { actionMulti, runSingle } from './multi'

/**
 * Top-level dispatcher. Handles the unclear/multi shapes; everything else
 * is routed through runSingle().
 */
export async function dispatchOperatorIntent(
  ctx: ActionContext,
  intent: OperatorIntent,
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  if (intent.kind === 'unclear') {
    return { ackBody: intent.ask_back } // empty string → caller queues nothing
  }
  if (intent.kind === 'multi') {
    return actionMulti(ctx, intent, pending)
  }
  return runSingle(ctx, intent, pending)
}

export type { ActionResult, ActionContext } from './types'
