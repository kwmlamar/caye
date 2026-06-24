import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { PendingHeldItem } from './pending'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

/**
 * Operator-reply intent classifier.
 *
 * Six categories per the build plan, plus `unclear` (ask back) and `multi`
 * (sequential sub-actions). Tool-use forces structured output.
 */

export type SingleOperatorIntent =
  | { kind: 'send'; item_ref?: string }
  | { kind: 'skip'; item_ref?: string }
  | { kind: 'edit'; item_ref?: string; instruction: string }
  | { kind: 'handled'; item_ref?: string }
  | { kind: 'query'; question: string }
  | { kind: 'mute'; duration_hours?: number; until_iso?: string }
  | { kind: 'unmute' }

export type OperatorIntent =
  | SingleOperatorIntent
  | { kind: 'multi'; actions: SingleOperatorIntent[] }
  | { kind: 'unclear'; ask_back: string }

export interface ClassifyInput {
  operatorText: string
  pending: PendingHeldItem[]
  lastCayeOutboundBody?: string | null
  // When the operator used WhatsApp's reply-to feature, Meta passes the quoted
  // message body through the webhook. If present, the classifier should bias
  // strongly toward associating the intent with that particular item.
  quotedMessage?: string | null
}

const SYSTEM = `You classify a service-business operator's WhatsApp reply to Caye, their AI assistant.

You return EXACTLY ONE structured intent via the classify_intent tool. Pick the most likely intent:

- send: operator wants Caye to send a drafted reply to the guest. Examples: "send it", "yes ship it", "good", "go ahead with 1", "looks good for 2".
- skip: operator wants Caye to close the item without replying. Examples: "skip", "ignore", "no reply", "leave it".
- edit: operator wants Caye to send a modified version. Examples: "tell her $250 instead", "say we're booked", "change the date to Friday".
- handled: operator already replied to the guest through their own channel. Examples: "handled", "I got it", "replied directly", "took care of it".
- query: operator is asking a question about workspace state. Examples: "what bookings today?", "anyone holding?", "what's pending?".
- mute: operator wants Caye to pause WhatsApp pings for a duration. Examples: "mute 2h", "quiet for 8 hours", "shush until tomorrow 8am", "mute me".
- unmute: operator wants pings to resume. Examples: "unmute", "back on", "resume".
- multi: operator references multiple items in one message. Examples: "1: send, 2: skip", "send 1 and edit 3 to say $200".
- unclear: low confidence — set ask_back to a single short Caye-voice question.

CONFIDENCE RULES:
- High confidence → act (return the intent directly).
- Medium confidence with ambiguity over WHICH item → set kind='unclear' with a short numbered ask_back.
- A filler-only message ("ok", "thanks", "cool", "👍") → kind='unclear' with ask_back="" (Caye stays silent).
- Multiple held items + no item_ref → set kind='unclear' asking which.
- Single held item + no item_ref → fill item_ref with "1".

ITEM REFS: use the 1-based number shown in PENDING ITEMS, OR a substring of the contact name.

VOICE for ask_back: terse, lowercase ok, no emoji, no tropical metaphors, no "I'd be happy to" — sound like a quick reply over the radio.`

const TOOL: Anthropic.Tool = {
  name: 'classify_intent',
  description: 'Return the classified intent for the operator reply.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['send', 'skip', 'edit', 'handled', 'query', 'mute', 'unmute', 'multi', 'unclear'],
      },
      item_ref: {
        type: 'string',
        description: '1-based index, contact name substring, or conversation id. Required for send/skip/edit/handled when multiple items are pending.',
      },
      instruction: {
        type: 'string',
        description: 'For kind=edit: operator\'s instruction on how to change the draft.',
      },
      question: {
        type: 'string',
        description: 'For kind=query: the operator\'s question, normalized.',
      },
      duration_hours: {
        type: 'number',
        description: 'For kind=mute: relative duration in hours.',
      },
      until_iso: {
        type: 'string',
        description: 'For kind=mute: absolute time (ISO 8601) to mute until. Mutually exclusive with duration_hours.',
      },
      ask_back: {
        type: 'string',
        description: 'For kind=unclear: a single short Caye-voice question. Empty string when the message was pure filler (no reply needed).',
      },
      actions: {
        type: 'array',
        description: 'For kind=multi: list of sub-intent objects with the same schema (excluding nested multi).',
        items: { type: 'object' },
      },
    },
    required: ['kind'],
  },
}

// Classifier-shape call: structured tool output, no voice generation, no
// multi-turn reasoning. Routed to Haiku 4.5 for ~80-90% input / ~75% output
// cost reduction vs Sonnet. Sonnet fallback fires on JSON-parse failure or
// missing required `kind` field — single retry, logged for audit.
// Locked 2026-06-24 (#47).
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'
const CLASSIFIER_FALLBACK_MODEL = 'claude-sonnet-4-6'

async function callClassifier(
  client: Anthropic,
  model: string,
  userContent: string
): Promise<OperatorIntent | null> {
  const response = await loggedMessagesCreate(client, {
    model,
    max_tokens: 600,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'classify_intent' },
    messages: [{ role: 'user', content: userContent }],
  }, { source: 'lib/whatsapp/intent.ts:callClassifier' })

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'classify_intent'
  )
  if (!toolUse) return null

  const raw = toolUse.input as Record<string, unknown>
  if (typeof raw.kind !== 'string') return null

  return normalizeIntent(raw)
}

export async function classifyOperatorIntent(input: ClassifyInput): Promise<OperatorIntent> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const pendingBlock = input.pending.length
    ? 'PENDING HELD ITEMS:\n' +
      input.pending
        .map(
          (it) =>
            `${it.index}. ${it.contactName} (${it.channelType}) — ${it.reason ?? 'no reason recorded'}` +
            (it.lastMessagePreview ? `\n   Last from guest: "${it.lastMessagePreview}"` : '') +
            (it.proposedReply ? `\n   Caye's draft: "${it.proposedReply.slice(0, 200)}"` : '')
        )
        .join('\n')
    : 'PENDING HELD ITEMS: none.'

  const userContent =
    pendingBlock +
    (input.lastCayeOutboundBody
      ? `\n\nMOST RECENT CAYE OUTBOUND TO OPERATOR:\n"${input.lastCayeOutboundBody.slice(0, 500)}"`
      : '') +
    (input.quotedMessage
      ? `\n\nOPERATOR REPLIED TO THIS MESSAGE (use it to disambiguate the item_ref):\n"${input.quotedMessage.slice(0, 500)}"`
      : '') +
    `\n\nOPERATOR REPLY:\n"${input.operatorText}"`

  const haikuResult = await callClassifier(client, CLASSIFIER_MODEL, userContent)
  if (haikuResult) return haikuResult

  console.warn(
    '[intent] Haiku classifier returned no valid tool_use; falling back to Sonnet for this call'
  )
  const sonnetResult = await callClassifier(client, CLASSIFIER_FALLBACK_MODEL, userContent)
  if (sonnetResult) return sonnetResult

  return { kind: 'unclear', ask_back: '' }
}

function normalizeIntent(raw: Record<string, unknown>): OperatorIntent {
  const kind = raw.kind as string
  switch (kind) {
    case 'send':
      return { kind: 'send', item_ref: optString(raw.item_ref) }
    case 'skip':
      return { kind: 'skip', item_ref: optString(raw.item_ref) }
    case 'edit':
      return {
        kind: 'edit',
        item_ref: optString(raw.item_ref),
        instruction: optString(raw.instruction) ?? '',
      }
    case 'handled':
      return { kind: 'handled', item_ref: optString(raw.item_ref) }
    case 'query':
      return { kind: 'query', question: optString(raw.question) ?? '' }
    case 'mute': {
      const out: OperatorIntent = { kind: 'mute' }
      const dh = raw.duration_hours
      if (typeof dh === 'number') out.duration_hours = dh
      const ui = optString(raw.until_iso)
      if (ui) out.until_iso = ui
      return out
    }
    case 'unmute':
      return { kind: 'unmute' }
    case 'multi': {
      const actions = Array.isArray(raw.actions) ? raw.actions : []
      const sub = actions
        .map((a) => normalizeIntent(a as Record<string, unknown>))
        .filter(
          (a): a is SingleOperatorIntent => a.kind !== 'multi' && a.kind !== 'unclear'
        )
      if (sub.length === 0) return { kind: 'unclear', ask_back: '' }
      if (sub.length === 1) return sub[0]
      return { kind: 'multi', actions: sub }
    }
    case 'unclear':
    default:
      return { kind: 'unclear', ask_back: optString(raw.ask_back) ?? '' }
  }
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
