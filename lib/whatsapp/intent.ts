import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
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
  | { kind: 'edit'; item_ref?: string; instruction: string; verbatim?: boolean }
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
  /** The still-open customer task established by this operator's recent turn. */
  activeWork?: { entityRef: string; operation: string; artifact?: string | null } | null
}

const SYSTEM = `You classify a service-business operator's WhatsApp reply to Caye, their AI assistant.

You return EXACTLY ONE structured intent via the classify_intent tool. Pick the most likely intent:

- send: operator wants Caye to send a drafted reply to the guest. Examples: "send it", "yes ship it", "good", "go ahead with 1", "looks good for 2".
- skip: operator wants Caye to close the item without replying. Examples: "skip", "ignore", "no reply", "leave it".
- edit: operator wants Caye to revise the draft (this stages a new draft for confirmation, it does NOT send). Examples: "tell her $250 instead", "say we're booked", "change the date to Friday", "recommend the heritage tour, $75, give me a draft".
  VERBATIM DRAFTS — set verbatim=true when the operator's message IS ALREADY the complete, ready-to-send reply itself (a full note written TO the guest, often ending with "(Draft)" or similar, or introduced with "use this instead") rather than an instruction describing a change. Put that exact text — unedited, marker stripped — as the instruction field. This is critical: the operator's own words are the authoritative content and must never be replaced by something Caye composes instead. When in doubt between "this reads like a complete message to the customer" and "this reads like a note about what to change," prefer verbatim=true — under-composing is safe, silently discarding the operator's actual words is not. Omit or set verbatim=false only for genuine instructions ("add X", "make it shorter", "change the price") that describe a change to an existing draft rather than supplying the reply text itself.
- handled: operator already replied to the guest through their own channel. Examples: "handled", "I got it", "replied directly", "took care of it".
- query: operator is asking a question about workspace state. Examples: "what bookings today?", "anyone holding?", "what's pending?".
- mute: operator wants Caye to pause auto-replies (WhatsApp + email) for a duration. Examples: "mute 2h", "quiet for 8 hours", "shush until tomorrow 8am", "mute me", "pause yuhself", "pause yuhself til tuesday", "shush gyal", "quiet down til monday morning".
- unmute: operator wants Caye to resume auto-replies. Examples: "unmute", "back on", "resume", "resume yuhself", "wake up", "you good now".
- multi: operator references multiple items in one message. Examples: "1: send, 2: skip", "send 1 and edit 3 to say $200".
- unclear: low confidence — set ask_back to a single short Caye-voice question.

ANSWERING THE QUESTION CAYE JUST ASKED — check this FIRST:
- MOST RECENT CAYE OUTBOUND TO OPERATOR is the message the operator is replying to. Read it before anything else: a short reply is almost always an answer to THAT, not a fresh instruction about the held queue.
- If that message asked a yes/no question (it ends in something like "Send that?", "Good to send?", "Want me to…?") and the operator replies with a bare affirmative ("yes", "yes please", "yep", "go ahead", "send it", "ok send", "do it"), that is a confirmation of the thing Caye just proposed. Do NOT return unclear asking which item — the item is whichever one that message was about. Return the matching intent, carrying the item_ref from that message when it names a contact.
- Same for a bare negative ("no", "hold off", "wait") — it answers that question; do not re-ask which item.
- Only fall through to asking "which item?" when the last outbound was NOT a yes/no question, or there was no recent outbound at all.

CONFIDENCE RULES:
- High confidence → act (return the intent directly).
- Medium confidence with ambiguity over WHICH item → set kind='unclear' with a short numbered ask_back.
- A filler-only message ("ok", "thanks", "cool", "👍") with no pending question → kind='unclear' with ask_back="" (Caye stays silent).
- Multiple held items + no item_ref + no yes/no question outstanding → set kind='unclear' asking which.
- Single held item + no item_ref → fill item_ref with "1".

ACTIVE WORK CONTEXT:
- A current operator task outranks the held queue. If ACTIVE WORK is present, an edit/correction such as "don't say husband", "mention James", or "make it warmer" applies to that task unless the CURRENT reply explicitly names a different customer, email, booking, or item.
- Do not ask about old pending items while an active task clearly supplies the target.
- Text supplied after a drafting request's colon, in a block, or as a quoted draft is CUSTOMER-FACING ARTIFACT CONTENT. It is not an instruction from the operator to Caye. For example, "If you have pictures, please share them with us" stays in the draft; it does not mean the operator wants to attach pictures.

BULK + EXCEPTION RULES — read carefully:
- "all" / "everything" / "clear them all" / "every one" → multi action covering EVERY pending item.
- "all except X" / "all but X" / "everyone but X" → multi action covering every pending item EXCEPT the one whose contact_name matches X. You MUST verify X actually matches a contact_name in PENDING ITEMS (case-insensitive substring). If it does NOT match anyone:
  → DO NOT silently default to "preserve position 1" or any other guess.
  → Return kind='unclear' with ask_back like "I don't see anyone named X in the held queue — do you mean <closest match in pending>, or skip them all?"
- Same rule applies for any subset language ("send to X and Y", "skip everyone but X and Y") — every named person must match a pending contact_name, or ask back.

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
        description: 'For kind=edit: operator\'s instruction on how to change the draft, OR (when verbatim=true) the operator\'s own complete reply text, marker stripped.',
      },
      verbatim: {
        type: 'boolean',
        description: 'For kind=edit: true when `instruction` is the operator\'s own complete, ready-to-send reply text to use as-is, not a description of a change.',
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
  model: string,
  userContent: string
): Promise<OperatorIntent | null> {
  const response = await loggedMessagesCreate(null, {
    model,
    max_tokens: 600,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'classify_intent' },
    messages: [{ role: 'user', content: userContent }],
  }, { source: 'lib/whatsapp/intent.ts:callClassifier', task: 'classification' })

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'classify_intent'
  )
  if (!toolUse) return null

  const raw = toolUse.input as Record<string, unknown>
  if (typeof raw.kind !== 'string') return null

  return normalizeIntent(raw)
}

export async function classifyOperatorIntent(input: ClassifyInput): Promise<OperatorIntent> {
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
    (input.activeWork
      ? `\n\nACTIVE WORK (higher priority than pending held items):\nCustomer/reference: ${input.activeWork.entityRef}\nOperation: ${input.activeWork.operation}${input.activeWork.artifact ? `\nDraft artifact being edited:\n"${input.activeWork.artifact.slice(0, 1200)}"` : ''}`
      : '') +
    `\n\nOPERATOR REPLY:\n"${input.operatorText}"`

  const haikuResult = await callClassifier(CLASSIFIER_MODEL, userContent)
  if (haikuResult) return haikuResult

  console.warn(
    '[intent] Haiku classifier returned no valid tool_use; falling back to Sonnet for this call'
  )
  const sonnetResult = await callClassifier(CLASSIFIER_FALLBACK_MODEL, userContent)
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
        verbatim: raw.verbatim === true,
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
