import 'server-only'

import type { Tool, ToolContext } from '../types'
import {
  invokeFounderResearchInvestigateCapability,
  invokeFounderResearchStartCapability,
} from '@/lib/capabilities/gateway'
import type { FounderResearchProgramKey } from '@/lib/capabilities/research-investigate'

type CapabilityToolContext = ToolContext & { founderUserId?: string }

type Args = {
  /** Existing-question path retained for explicit research.start behavior. */
  questionId?: string
  /** Unverified proposition/topic extracted from the founder's request. */
  lead?: string
  /** Epistemically neutral question Caye should actually verify. */
  verificationQuestion?: string
  /** Stable subject/relation key, e.g. "nvidia:hugging-face:acquisition". */
  canonicalKey?: string
  /** Choose only when the domain is defensible; otherwise use wildcard. */
  program?: FounderResearchProgramKey
}

const PROGRAMS = [
  'ai_global_technology',
  'caye_ai_systems',
  'career_economic_opportunity',
  'markets_business_capital',
  'wildcard_global_discovery',
] as const

/**
 * Founder-only adapter for canonical research writes. It supports both the old
 * existing-question enqueue and a new ad-hoc Direct investigation. The model
 * supplies the epistemic framing; founder identity and Direct provenance come
 * only from ambient trusted server context.
 */
export const startCanonicalResearchTool: Tool<Args> = {
  name: 'start_canonical_research',
  description:
    'Founder-only low-risk Caye Direct research action. Use it when the founder says look into, investigate, research, verify, or keep an eye on something. For a new topic, treat factual assertions as UNVERIFIED LEADS, never facts: provide lead, a neutral verificationQuestion, a stable canonicalKey describing the subject/relation, and the best canonical program (use wildcard_global_discovery when no domain clearly fits). This creates/reuses a durable canonical question and queues the existing research runtime. Use questionId only when starting an already-known canonical question.',
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      questionId: { type: 'string', minLength: 1 },
      lead: { type: 'string', minLength: 1 },
      verificationQuestion: { type: 'string', minLength: 1 },
      canonicalKey: { type: 'string', minLength: 1, maxLength: 180 },
      program: { type: 'string', enum: [...PROGRAMS] },
    },
    additionalProperties: false,
  },
  async execute(args, rawCtx) {
    if (rawCtx.channel !== 'dashboard') {
      return { ok: false, error: 'Canonical research writes are available only in founder Caye Direct.' }
    }

    const ctx = rawCtx as CapabilityToolContext
    if (!ctx.founderUserId) {
      return {
        ok: false,
        error: 'Verified founder identity is unavailable on this conversation path. Research was not started.',
      }
    }

    const questionId = args.questionId?.trim()
    if (questionId) {
      const result = await invokeFounderResearchStartCapability(ctx.founderUserId, {
        capability: 'research.start',
        version: 1,
        workspaceId: null,
        args: { questionId },
      })
      return result.status === 'failed'
        ? { ok: false, error: result.failure.message, data: result }
        : { ok: true, data: result }
    }

    const lead = args.lead?.trim()
    const verificationQuestion = args.verificationQuestion?.trim()
    const canonicalKey = args.canonicalKey?.trim()
    const program = args.program
    if (!lead || !verificationQuestion || !canonicalKey || !program) {
      return {
        ok: false,
        error: 'New research requires lead, verificationQuestion, canonicalKey, and program. The lead must remain unverified.',
      }
    }

    // `engineeringOrigin` is already the durable server-created Direct
    // thread/message pair. Channel is checked separately above, so its presence
    // is not being used as a generic "is Direct" signal here; only its trusted
    // ids are reused as provenance until ToolContext gets a general Direct-origin
    // carrier in a broader cleanup.
    const directOrigin = ctx.engineeringOrigin
    if (!directOrigin?.threadId || !directOrigin.messageId) {
      return { ok: false, error: 'Durable founder Direct provenance is unavailable. Research was not created.' }
    }

    const result = await invokeFounderResearchInvestigateCapability(
      ctx.founderUserId,
      {
        workspaceId: ctx.workspaceId,
        threadId: directOrigin.threadId,
        messageId: directOrigin.messageId,
      },
      {
        capability: 'research.investigate',
        version: 1,
        workspaceId: null,
        args: { lead, verificationQuestion, canonicalKey, program },
      },
    )

    return result.status === 'failed'
      ? { ok: false, error: result.failure.message, data: result }
      : { ok: true, data: result }
  },
}
