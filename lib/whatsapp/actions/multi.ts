import 'server-only'
import type { SingleOperatorIntent } from '../intent'
import type { PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { actionSend } from './send'
import { actionSkip } from './skip'
import { actionEdit } from './edit'
import { actionHandled } from './handled'
import { actionQuery } from './query'
import { actionMute } from './mute'
import { actionUnmute } from './unmute'

type SingleIntent = SingleOperatorIntent

export async function actionMulti(
  ctx: ActionContext,
  intent: { actions: SingleIntent[] },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const results: ActionResult[] = []
  for (const sub of intent.actions) {
    // Re-resolve pending between sub-actions so each one sees a fresh view
    // (a previous send/skip clears human_agent_enabled).
    results.push(await runSingle(ctx, sub, pending))
  }

  const tags = results.map(
    (r, i) =>
      `${i + 1}. ${r.tag?.status === 'ok' ? '✓' : r.tag?.status === 'skipped' ? '–' : '⚠'} ` +
      `${r.tag?.label ?? 'done'}`
  )
  return {
    ackBody: tags.join(' / '),
  }
}

export async function runSingle(
  ctx: ActionContext,
  intent: SingleIntent,
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  switch (intent.kind) {
    case 'send':
      return actionSend(ctx, intent, pending)
    case 'skip':
      return actionSkip(ctx, intent, pending)
    case 'edit':
      return actionEdit(ctx, intent, pending)
    case 'handled':
      return actionHandled(ctx, intent, pending)
    case 'query':
      return actionQuery(ctx, intent, pending)
    case 'mute':
      return actionMute(ctx, intent)
    case 'unmute':
      return actionUnmute(ctx)
  }
}
