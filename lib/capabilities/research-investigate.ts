import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { queueResearchRun } from '@/lib/research/runtime'
import type { RegisteredCapability } from './types'

export const FOUNDER_RESEARCH_PROGRAMS = {
  ai_global_technology: 'AI & Global Technology Intelligence',
  caye_ai_systems: 'Caye AI Systems Research',
  career_economic_opportunity: 'Career & Economic Opportunity Intelligence',
  markets_business_capital: 'Markets, Business & Capital Intelligence',
  wildcard_global_discovery: 'Wildcard & Global Discovery Intelligence',
} as const

export type FounderResearchProgramKey = keyof typeof FOUNDER_RESEARCH_PROGRAMS

export type FounderResearchInvestigationArgs = {
  lead: string
  verificationQuestion: string
  canonicalKey: string
  program: FounderResearchProgramKey
  origin: {
    workspaceId: string
    threadId: string
    messageId: string
  }
}

const FALLBACK_PROGRAM: FounderResearchProgramKey = 'wildcard_global_discovery'

export function normalizeResearchCanonicalKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ':')
    .replace(/^:+|:+$/g, '')
    .slice(0, 180)
}

function failed(code: 'not_authorized' | 'invalid_scope' | 'invalid_args' | 'unavailable', message: string, retryable = false) {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code, message, retryable },
  }
}

async function resolveProgram(db: ReturnType<typeof createServiceClient>, requested: FounderResearchProgramKey) {
  const requestedTitle = FOUNDER_RESEARCH_PROGRAMS[requested] ?? FOUNDER_RESEARCH_PROGRAMS[FALLBACK_PROGRAM]
  const { data: requestedProgram, error: requestedError } = await db
    .from('research_programs')
    .select('id,title')
    .eq('scope', 'operator')
    .eq('status', 'active')
    .eq('title', requestedTitle)
    .maybeSingle()
  if (requestedError) throw requestedError
  if (requestedProgram) return requestedProgram

  const { data: fallback, error: fallbackError } = await db
    .from('research_programs')
    .select('id,title')
    .eq('scope', 'operator')
    .eq('status', 'active')
    .eq('title', FOUNDER_RESEARCH_PROGRAMS[FALLBACK_PROGRAM])
    .maybeSingle()
  if (fallbackError) throw fallbackError
  if (!fallback) throw new Error('Canonical wildcard research program is unavailable.')
  return fallback
}

async function findCurrentQuestion(db: ReturnType<typeof createServiceClient>, canonicalKey: string) {
  const { data, error } = await db
    .from('research_questions')
    .select('id,program_id,question,status,canonical_key')
    .eq('canonical_key', canonicalKey)
    .neq('status', 'archived')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Founder-only durable creation/reuse of an ad-hoc canonical research question.
 * The founder's assertion is stored only as an unverified origin lead. This
 * capability never inserts research_claims and never treats the wording as fact.
 */
export const researchInvestigateCapability: RegisteredCapability<FounderResearchInvestigationArgs> = {
  manifest: {
    name: 'research.investigate',
    version: 1,
    namespace: 'research',
    description: 'Create or reuse a durable founder research question from an unverified lead, record Direct provenance, and queue the canonical research runtime.',
    access: 'write',
    risk: 'low',
    inputSchemaId: 'research.investigate.input.v1',
    outputSchemaId: 'research.investigate.output.v1',
  },
  async execute(args, context) {
    if (context.actor.kind !== 'founder') {
      return failed('not_authorized', 'Research investigations can only be created by the founder.')
    }
    if (context.scope.workspaceId !== null) {
      return failed('invalid_scope', 'Founder research investigations are operator-scoped, not customer-workspace scoped.')
    }

    const lead = args?.lead?.trim()
    const verificationQuestion = args?.verificationQuestion?.trim()
    const canonicalKey = normalizeResearchCanonicalKey(args?.canonicalKey ?? '')
    const origin = args?.origin
    if (!lead || !verificationQuestion || !canonicalKey || !origin?.workspaceId || !origin.threadId || !origin.messageId) {
      return failed('invalid_args', 'lead, verificationQuestion, canonicalKey, and trusted Direct origin are required.')
    }
    if (!(args.program in FOUNDER_RESEARCH_PROGRAMS)) {
      return failed('invalid_args', 'Unknown canonical research program.')
    }

    try {
      const db = createServiceClient()

      // Re-read the durable inbound row instead of trusting model-supplied text.
      // The original founder wording therefore comes from the server-persisted
      // Direct turn and must belong to the exact workspace that produced it.
      const { data: inbound, error: inboundError } = await db
        .from('caye_operator_messages')
        .select('id,workspace_id,body,direction,origin,operator_role')
        .eq('id', origin.messageId)
        .eq('workspace_id', origin.workspaceId)
        .eq('direction', 'inbound')
        .eq('origin', 'dashboard')
        .eq('operator_role', 'founder')
        .maybeSingle()
      if (inboundError) throw inboundError
      if (!inbound?.id || typeof inbound.body !== 'string' || !inbound.body.trim()) {
        return failed('not_authorized', 'Trusted founder Direct provenance could not be verified.')
      }

      let question = await findCurrentQuestion(db, canonicalKey)
      let reused = Boolean(question)
      let programTitle: string

      if (!question) {
        const program = await resolveProgram(db, args.program)
        programTitle = program.title
        const inserted = await db
          .from('research_questions')
          .insert({
            program_id: program.id,
            question: verificationQuestion,
            status: 'open',
            canonical_key: canonicalKey,
          })
          .select('id,program_id,question,status,canonical_key')
          .single()

        if (inserted.error?.code === '23505') {
          // Two equivalent founder turns raced. The unique current-key index is
          // the authority; converge on the winner instead of manufacturing a duplicate.
          question = await findCurrentQuestion(db, canonicalKey)
          reused = true
        } else if (inserted.error) {
          throw inserted.error
        } else {
          question = inserted.data
        }
        if (!question) throw new Error('Canonical research question could not be created.')
      }

      if (!programTitle!) {
        const { data: programRow, error: programError } = await db
          .from('research_programs')
          .select('title')
          .eq('id', question.program_id)
          .eq('scope', 'operator')
          .maybeSingle()
        if (programError) throw programError
        if (!programRow) throw new Error('Canonical research program is unavailable.')
        programTitle = programRow.title
      }

      const originInsert = await db.from('research_question_origins').insert({
        question_id: question.id,
        founder_user_id: context.actor.userId,
        source_workspace_id: origin.workspaceId,
        direct_thread_id: origin.threadId,
        inbound_message_id: String(inbound.id),
        original_wording: inbound.body.trim(),
        lead_text: lead,
        verification_question: verificationQuestion,
      })
      if (originInsert.error && originInsert.error.code !== '23505') throw originInsert.error

      const run = await queueResearchRun(question.id, 'founder_direct')
      return {
        status: 'staged',
        data: {
          durable: true,
          reused,
          epistemicStatus: 'unverified_lead',
          questionId: question.id,
          verificationQuestion: question.question,
          canonicalKey,
          program: programTitle,
          runId: run.id,
          runStatus: run.status,
          next: 'The initial canonical research run is queued. Evidence-backed claims and briefs will be produced by the existing research runtime.',
        },
        evidence: [
          { kind: 'record', id: `research_question:${question.id}` },
          { kind: 'record', id: `research_run:${run.id}` },
        ],
        executionRef: null,
        auditRef: `research_question:${question.id}`,
        failure: null,
      }
    } catch (error) {
      return failed('unavailable', error instanceof Error ? error.message : 'Research investigation could not be created.', true)
    }
  },
}
