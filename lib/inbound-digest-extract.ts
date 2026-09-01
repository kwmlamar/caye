import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { normalizeDigest, type InboundDigest } from '@/lib/inbound-digest'

/**
 * The LLM half of the inbound digest — see lib/inbound-digest.ts for the
 * schema, the deterministic renderer, and why prefix-truncating a business
 * email was never salvageable.
 *
 * SPLIT FROM THE RENDERER ON PURPOSE. lib/operator-brief.ts is a pure,
 * synchronous, fully unit-tested module and must stay that way — it is the
 * thing standing between a machine payload and an owner's WhatsApp. Pulling
 * the Anthropic SDK and `server-only` into its import graph would make it
 * unloadable from a plain test and untestable without mocking a network
 * client. So: meaning is extracted here (async, server-only, mockable at one
 * seam), and shaped there (pure, deterministic, asserted line by line).
 */

const MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 900

/** How much of the inbound the extractor reads. Generous — the ask is
 *  usually late, which is the entire point of this module. Only bites on
 *  pathological input; a normal business email is far below this. */
const EXTRACT_INPUT_MAX = 12000

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_reading',
  description:
    'Record your structured reading of the message. Every field is either grounded in the text or null.',
  input_schema: {
    type: 'object',
    properties: {
      sender: {
        type: ['string', 'null'],
        description: 'Person who wrote it, as signed. Null if unsigned.',
      },
      organization: {
        type: ['string', 'null'],
        description: 'Company or organization they write for. Null for a private individual.',
      },
      intent: {
        type: 'string',
        description:
          'What they want, in your own words, ONE sentence. Never quote them. If they want nothing yet, say what the message is (e.g. "acknowledging the questions and promising a full answer later").',
      },
      whyItMatters: {
        type: ['string', 'null'],
        description:
          'The business stake for the owner, one short clause. Null if there genuinely is none.',
      },
      currentStatus: {
        type: ['string', 'null'],
        description: 'Where the conversation stands now, one short clause.',
      },
      requestedAction: {
        type: ['string', 'null'],
        description:
          'The specific thing they are asking the business to do. Null if they asked for nothing.',
      },
      deadline: {
        type: ['string', 'null'],
        description:
          'Any date or time constraint they stated. Null if none stated. Never invent urgency.',
      },
      financialImpact: {
        type: ['string', 'null'],
        description:
          'Money at stake, only if the message names or clearly implies figures. Null otherwise.',
      },
      commitmentsMade: {
        type: ['string', 'null'],
        description:
          'What the business has already promised this person, if the thread shows it. Null if nothing was promised.',
      },
      recommendedAction: {
        type: ['string', 'null'],
        description:
          'What you would advise the owner to do, one sentence, first person ("Take the call."). Null when the evidence does not support a recommendation — that is a valid answer.',
      },
      decisionNeeded: {
        type: ['string', 'null'],
        description:
          'The single thing ONLY THE OWNER can decide, phrased as one short question. Null in every other case, including when the sender asked a question that someone with access to the calendar, the price list, and the business\'s own policies could answer. An open question is not automatically an owner decision. Do NOT manufacture one to seem useful.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'high = read directly off the text. low = largely inferred.',
      },
      substantive: {
        type: 'boolean',
        description:
          'Does this carry real business content at all? False for an acknowledgement, a holding note, a thank-you, an "I will reply properly soon". True whenever there is real content — INCLUDING content that needs nothing done about it.',
      },
      actionNeeded: {
        type: 'boolean',
        description:
          'Does anyone have to DO something as a result — the business or the owner? False for a notice, an FYI, a policy update, anything that says no action is required. A message can be substantive and still need nothing: "the fuel dock has reduced hours next week" is worth knowing and requires nothing.',
      },
    },
    required: ['intent', 'confidence', 'substantive', 'actionNeeded'],
  },
}

const EXTRACTION_SYSTEM = [
  'You read an inbound business message and record what it actually means for the business owner.',
  '',
  'The owner is busy. Someone else already read this message; your job is to make reading it again unnecessary.',
  '',
  'RULES',
  '- Extract the ASK, not the opening. Business emails put pleasantries first and the request last. The greeting, the thanks, and the compliments carry no information — skip them entirely.',
  '- Write intent in YOUR OWN WORDS. Never quote the sender. A quote is what happens when a summary was not attempted.',
  '- Ground every field in the text. If the message states no deadline, deadline is null. If it names no money, financialImpact is null. Inventing these is worse than omitting them.',
  '- If the message has no real content yet — an acknowledgement, a "thanks, I will reply properly soon", a holding note, a thank-you — set substantive to false and say so plainly in intent. That is a complete and useful reading, not a failure.',
  '- KEEP TWO QUESTIONS APART: "does this carry real business content" (substantive) and "does anyone have to do anything" (actionNeeded). A notice that says no action is required is substantive AND actionNeeded=false. Do not collapse them.',
  '',
  'WHAT COUNTS AS AN OWNER DECISION — get this wrong and you invent work for a busy person',
  'Set decisionNeeded ONLY when at least one of these is true:',
  '  - it commits money the owner has not already agreed to (a discount, a refund, a rate, a commission),',
  '  - it sets a precedent — pricing, policy, or terms that would apply again,',
  '  - it is irreversible and consequential (cancelling, turning away a booking, committing capacity),',
  '  - it needs something only the owner knows (whether they personally want this client, private history, their own availability),',
  '  - or it is a judgment call between real alternatives.',
  'Everything else is NOT an owner decision, even though it is an open question:',
  '  - "are you free Sunday?" is a calendar lookup,',
  '  - "do you provide snorkel gear?" / "is there a toilet on board?" / "can you collect from the other dock?" are questions about how the business already operates,',
  '  - "what is the rate for 4 people?" is the published price list.',
  'Someone with access to the calendar, the price list and the business\'s own policies answers all of those without troubling the owner. For those, describe the ask in requestedAction and leave decisionNeeded null.',
  'A question invented to look helpful wastes the scarcest thing the owner has.',
  '',
  '- Give a recommendation when the evidence supports one. When it does not, null is the honest answer.',
  '- Refer to people by name. Never use he/she — you do not know.',
  '- Never mention email structure, your own process, or that you are summarizing.',
].join('\n')

/**
 * Read an inbound prose message into the structured digest.
 *
 * Returns null on any failure — a malformed response, an API error, an
 * empty body. Callers MUST have a deterministic fallback; this never
 * throws, because an escalation ping going out slightly worse is a far
 * better outcome than one not going out at all.
 */
export async function extractInboundDigest(args: {
  body: string
  contactName?: string | null
  /** What Caye already sent this person on the thread, if anything. Lets
   *  the extractor fill commitmentsMade from evidence rather than guess. */
  alreadySent?: string | null
  workspaceId?: string
}): Promise<InboundDigest | null> {
  const body = (args.body ?? '').trim()
  if (!body) return null

  const context = [
    args.contactName ? `Message is from: ${args.contactName}` : null,
    args.alreadySent
      ? `What the business has already sent this person on this thread: "${args.alreadySent.replace(/\s+/g, ' ').trim()}"`
      : 'The business has not replied to this person yet on this thread.',
    '',
    'The message:',
    body.slice(0, EXTRACT_INPUT_MAX),
  ]
    .filter((l) => l !== null)
    .join('\n')

  try {
    const response = await loggedMessagesCreate(
      null,
      {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: context }],
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
      },
      { source: 'lib/inbound-digest-extract.ts:extractInboundDigest', task: 'fact_extraction', workspaceId: args.workspaceId }
    )

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === EXTRACTION_TOOL.name
    )
    if (!block) return null
    return normalizeDigest(block.input as Record<string, unknown>)
  } catch (err) {
    console.error('[inbound-digest] extraction failed:', err)
    return null
  }
}
