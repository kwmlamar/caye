import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { gateHighRisk, stableArgsKey } from './high-risk-gate'
import type { Tool, ToolContext, ToolResult } from './types'

interface OutreachTargetArgs {
  vertical?: unknown
  region?: unknown
}

interface AuthorizationMessage {
  direction: 'inbound' | 'outbound'
  body: string | null
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function isExplicitBoundedOutreachAuthorization(text: string): boolean {
  const normalized = normalize(text)
  return (
    /\bcontinue with (?:the )?(?:three|3) test batches without waiting(?: for me)?\b/.test(normalized) ||
    /\b(?:proceed|continue|stage|run|start) (?:with )?(?:all|the) (?:three|3)\b.*\bwithout waiting(?: for me)?\b/.test(normalized) ||
    /\bkeep those priorities\b.*\bwithout waiting(?: for me)?\b/.test(normalized)
  )
}

export function messageSequenceAuthorizesOutreachTarget(
  messages: readonly AuthorizationMessage[],
  args: OutreachTargetArgs,
): boolean {
  if (typeof args.vertical !== 'string' || typeof args.region !== 'string') return false
  const vertical = normalize(args.vertical)
  const region = normalize(args.region)
  if (!vertical || !region) return false

  let exactProposalSeen = false
  for (const message of messages) {
    const body = typeof message.body === 'string' ? normalize(message.body) : ''
    if (!body) continue

    if (message.direction === 'outbound') {
      if (body.includes(vertical) && body.includes(region)) exactProposalSeen = true
      continue
    }

    if (exactProposalSeen && isExplicitBoundedOutreachAuthorization(body)) return true
  }
  return false
}

async function hasPersistedAuthorization(args: OutreachTargetArgs, ctx: ToolContext): Promise<boolean> {
  // This pre-authorization is intentionally founder-Direct-only. WhatsApp,
  // scans, ambiguous identity, and non-threaded turns fail closed to the
  // ordinary high-risk confirmation gate.
  if (ctx.origin === 'scan' || ctx.channel !== 'dashboard' || ctx.operatorId == null) return false

  // founder-thread-turn currently supplies the durable Direct thread/message
  // identity in engineeringOrigin for every dashboard turn. We use only the
  // thread id here and still require channel=dashboard. This is deliberately
  // narrow to expand_outreach_target; no other high-risk action consumes it.
  const threadId = ctx.engineeringOrigin?.threadId
  if (!threadId) return false

  const db = createServiceClient()
  const { data: links, error: linksError } = await db
    .from('caye_direct_thread_messages')
    .select('message_id')
    .eq('thread_id', threadId)
  if (linksError || !links?.length) return false

  const messageIds = links.map((row) => row.message_id as string).filter(Boolean)
  if (!messageIds.length) return false

  let query = db
    .from('caye_operator_messages')
    .select('direction, body, created_at')
    .in('id', messageIds)
    .eq('workspace_id', ctx.workspaceId)
    .eq('operator_allowlist_id', ctx.operatorId)
    .eq('origin', 'dashboard')
    .order('created_at', { ascending: true })

  const { data: messages, error: messagesError } = await query
  if (messagesError || !messages) return false

  return messageSequenceAuthorizesOutreachTarget(
    messages as AuthorizationMessage[],
    args,
  )
}

async function retireMatchingPendingAction(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
  result: ToolResult,
): Promise<void> {
  const db = createServiceClient()
  let query = db
    .from('caye_pending_actions')
    .update({ executed_at: new Date().toISOString(), result })
    .eq('workspace_id', ctx.workspaceId)
    .eq('tool_name', toolName)
    .eq('args_key', stableArgsKey(args))
    .is('executed_at', null)
    .is('cancelled_at', null)

  query = ctx.operatorId != null
    ? query.eq('operator_id', ctx.operatorId)
    : query.is('operator_id', null)

  await query
}

/**
 * Narrow exception to the generic high-risk round-trip for one action only.
 * The underlying tool remains high-risk and confirmable. Durable, exact,
 * thread-scoped founder authorization may satisfy the confirmation step;
 * otherwise the normal gate is used unchanged.
 */
export function gateBoundedOutreachTarget<T>(tool: Tool<T>): Tool<T> {
  const ordinaryGate = gateHighRisk(tool)
  return {
    ...ordinaryGate,
    async execute(args, ctx) {
      let authorized = false
      try {
        authorized = await hasPersistedAuthorization(args as OutreachTargetArgs, ctx)
      } catch {
        authorized = false
      }

      if (!authorized) return ordinaryGate.execute(args, ctx)

      const result = await tool.execute(args, ctx)
      if (result.ok) {
        await retireMatchingPendingAction(tool.name, args, ctx, result).catch(() => undefined)
      }
      return result
    },
  }
}
