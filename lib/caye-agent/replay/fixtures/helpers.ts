import type Anthropic from '@anthropic-ai/sdk'
import { annotateHistoryWithRelativeTime, type CayeSituation, type OperationalContext, type RelationshipContext, type WorkOpportunityContext } from '../../situation'
import type { Role, Tool, ToolContext } from '../../tools/types'

/**
 * replay/fixtures/helpers.ts
 *
 * Pure, DB-free construction helpers shared by every Case A–F fixture.
 * Nothing here touches Supabase or the Anthropic API — fixtures built with
 * these are safe to construct (and unit-test the construction of) without
 * network access. Running one against a real model is a separate, manual
 * step — see replay/fixtures/README-equivalent note in each case file.
 */

export interface SyntheticTurn {
  role: 'user' | 'assistant'
  content: string
  /** ISO timestamp this turn happened at, in the fixture's fictional timeline. */
  at: string
}

export function buildSyntheticSituation(args: {
  channel: 'back-office' | 'front-desk'
  workspaceId: string
  now: string
  turns: SyntheticTurn[]
  relationship?: RelationshipContext | null
  workOpportunities?: WorkOpportunityContext[]
  operational?: Partial<OperationalContext>
}): CayeSituation {
  const history: Anthropic.MessageParam[] = args.turns.map((t) => ({ role: t.role, content: t.content }))
  const historyTimestamps: (string | null)[] = args.turns.map((t) => t.at)
  const historyForModel = annotateHistoryWithRelativeTime(history, historyTimestamps, args.now)

  return {
    channel: args.channel,
    workspaceId: args.workspaceId,
    now: args.now,
    history,
    historyTimestamps,
    historyForModel,
    relationship: args.relationship ?? null,
    workOpportunities: args.workOpportunities ?? [],
    operational: {
      standingRules: args.operational?.standingRules ?? [],
      businessFacts: args.operational?.businessFacts ?? [],
      attentionDelta: args.operational?.attentionDelta ?? null,
    },
  }
}

export function fixtureCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws_fixture',
    callerRole: 'owner',
    requestId: 'req_fixture',
    operatorId: 1,
    evidenceCollected: [],
    ...overrides,
  }
}

/** Canned-data read tool. Read tools are never dry-run-wrapped (they're
 *  side-effect-free by design), so this is what the model actually sees
 *  when it calls it — a fixed fact, not a live database. */
export function fakeReadTool<T>(name: string, description: string, data: unknown): Tool<T> {
  return {
    name,
    description,
    risk: 'read',
    roles: ['owner', 'staff', 'founder'],
    modes: ['back-office', 'front-desk'],
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, data }
    },
  }
}

/**
 * Write-tool stand-in. `execute` here is a stub that should never actually
 * run inside a replay — `wrapToolsForDryRun` (applied by `runReplayTurn`)
 * intercepts every tool with `risk !== 'read'` before the model's call can
 * reach it. It exists so callers exercising the wrapper directly (see
 * `tools/dry-run.test.ts`) have something realistic to wrap.
 *
 * `inputSchema` defaults to empty for tools where no fixture needs the
 * model to supply real arguments. PHASE 1B FINDING: an earlier version of
 * this helper hardcoded the empty schema for every write tool, including
 * `send_reply` — Claude correctly declined to invent fields the schema
 * never declared (conversation_id/body), so every send_reply call across
 * three live fixtures went out with `input: {}`. That's the model
 * respecting its contract, not a reasoning failure, but it meant those
 * fixtures weren't actually testing what they claimed to. Callers building
 * a `send_reply` (or any tool whose arguments matter to the scenario) must
 * now pass the real schema — see `SEND_REPLY_SCHEMA` below for the one
 * copied verbatim from `tools/write-high/send-reply.ts`.
 */
export function fakeWriteTool<T>(
  name: string,
  description: string,
  risk: 'low' | 'high',
  roles: Role[] = ['owner', 'founder'],
  inputSchema: Tool<T>['inputSchema'] = { type: 'object', properties: {} }
): Tool<T> {
  return {
    name,
    description,
    risk,
    roles,
    modes: ['back-office', 'front-desk'],
    inputSchema,
    async execute() {
      return { ok: true, data: { note: 'fixture stub executed for real — should not happen inside runReplayTurn' } }
    },
  }
}

/**
 * The real `send_reply` input schema, copied verbatim from
 * `lib/caye-agent/tools/write-high/send-reply.ts` so fixtures that need
 * the model to actually supply a conversation_id/body see the same
 * contract production does.
 */
export const SEND_REPLY_SCHEMA: Tool<never>['inputSchema'] = {
  type: 'object',
  properties: {
    conversation_id: {
      type: 'string',
      description: 'The conversation_id from get_held_queue / get_customer / search_threads.',
    },
    body: {
      type: 'string',
      description:
        "The exact text to send. Will be delivered as-is to the customer via their channel (email / WhatsApp / IG / Messenger). Already-confirmed copy in the operator's voice.",
    },
  },
  required: ['conversation_id', 'body'],
}
