import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { currentDirectRunId } from '@/lib/caye-direct-run-context'
import { linkDirectRunToResearch } from '@/lib/caye-direct-runs'
import { queueResearchRun } from '@/lib/research/runtime'
import type { InvestigationMode } from '@/lib/research/investigation-lifecycle'
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
  mode?: InvestigationMode
  refreshIntervalHours?: number
  origin: { workspaceId: string; threadId: string; messageId: string }
}

const FALLBACK_PROGRAM: FounderResearchProgramKey = 'wildcard_global_discovery'
const MODES: InvestigationMode[] = ['one_shot', 'follow_until_resolved', 'monitor']
const MODE_WEIGHT: Record<InvestigationMode, number> = { one_shot: 0, follow_until_resolved: 1, monitor: 2 }
const MONITOR_LANGUAGE = /\b(keep\s+(an\s+)?eye\s+on|keep\s+watching|monitor|track\s+this|watch\s+this|follow\s+this)\b/i

export function normalizeResearchCanonicalKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ':').replace(/^:+|:+$/g, '').slice(0, 180)
}

function failed(code: 'not_authorized' | 'invalid_scope' | 'invalid_args' | 'unavailable', message: string, retryable = false) {
  return { status: 'failed' as const, data: null, evidence: [], executionRef: null, auditRef: null, failure: { code, message, retryable } }
}

async function resolveProgram(db: ReturnType<typeof createServiceClient>, requested: FounderResearchProgramKey) {
  const requestedTitle = FOUNDER_RESEARCH_PROGRAMS[requested] ?? FOUNDER_RESEARCH_PROGRAMS[FALLBACK_PROGRAM]
  const { data: requestedProgram, error: requestedError } = await db.from('research_programs').select('id,title').eq('scope', 'operator').eq('status', 'active').eq('title', requestedTitle).maybeSingle()
  if (requestedError) throw requestedError
  if (requestedProgram) return requestedProgram
  const { data: fallback, error: fallbackError } = await db.from('research_programs').select('id,title').eq('scope', 'operator').eq('status', 'active').eq('title', FOUNDER_RESEARCH_PROGRAMS[FALLBACK_PROGRAM]).maybeSingle()
  if (fallbackError) throw fallbackError
  if (!fallback) throw new Error('Canonical wildcard research program is unavailable.')
  return fallback
}

async function findCurrentQuestion(db: ReturnType<typeof createServiceClient>, canonicalKey: string) {
  const { data, error } = await db.from('research_questions')
    .select('id,program_id,question,status,canonical_key,investigation_mode,lifecycle_status,refresh_interval_hours')
    .eq('canonical_key', canonicalKey).neq('status', 'archived').limit(1).maybeSingle()
  if (error) throw error
  return data
}

/** Founder-only durable creation/reuse of an ad-hoc canonical investigation. */
export const researchInvestigateCapability: RegisteredCapability<FounderResearchInvestigationArgs> = {
  manifest: {
    name: 'research.investigate', version: 1, namespace: 'research',
    description: 'Create or reuse a durable founder research question from an unverified lead, record Direct provenance, and queue the canonical research runtime.',
    access: 'write', risk: 'low', inputSchemaId: 'research.investigate.input.v1', outputSchemaId: 'research.investigate.output.v1',
  },
  async execute(args, context) {
    if (context.actor.kind !== 'founder') return failed('not_authorized', 'Research investigations can only be created by the founder.')

    const lead = args?.lead?.trim()
    const verificationQuestion = args?.verificationQuestion?.trim()
    const canonicalKey = normalizeResearchCanonicalKey(args?.canonicalKey ?? '')
    const origin = args?.origin
    const explicitMode = args.mode && MODES.includes(args.mode) ? args.mode : null
    if (!lead || !verificationQuestion || !canonicalKey || !origin?.workspaceId || !origin.threadId || !origin.messageId) {
      return failed('invalid_args', 'lead, verificationQuestion, canonicalKey, and trusted Direct origin are required.')
    }
    if (context.scope.workspaceId !== null && context.scope.workspaceId !== origin.workspaceId) {
      return failed('invalid_scope', 'Founder research origin does not match the active Direct workspace.')
    }
    if (!(args.program in FOUNDER_RESEARCH_PROGRAMS)) return failed('invalid_args', 'Unknown canonical research program.')
    if (args.refreshIntervalHours != null && (args.refreshIntervalHours < 1 || args.refreshIntervalHours > 720)) {
      return failed('invalid_args', 'refreshIntervalHours must be between 1 and 720.')
    }

    try {
      const db = createServiceClient()
      const { data: inbound, error: inboundError } = await db.from('caye_operator_messages')
        .select('id,workspace_id,body,direction,origin,operator_role')
        .eq('id', origin.messageId).eq('workspace_id', origin.workspaceId).eq('direction', 'inbound').eq('origin', 'dashboard').eq('operator_role', 'founder').maybeSingle()
      if (inboundError) throw inboundError
      if (!inbound?.id || typeof inbound.body !== 'string' || !inbound.body.trim()) return failed('not_authorized', 'Trusted founder Direct provenance could not be verified.')

      const mode: InvestigationMode = explicitMode ?? (MONITOR_LANGUAGE.test(inbound.body) ? 'monitor' : 'follow_until_resolved')
      const refreshIntervalHours = args.refreshIntervalHours == null ? (mode === 'monitor' ? 24 : 6) : Math.round(args.refreshIntervalHours)

      let question = await findCurrentQuestion(db, canonicalKey)
      let reused = Boolean(question)
      let programTitle = ''

      if (!question) {
        const program = await resolveProgram(db, args.program)
        programTitle = program.title
        const inserted = await db.from('research_questions').insert({
          program_id: program.id, question: verificationQuestion, status: 'open', canonical_key: canonicalKey,
          investigation_mode: mode, lifecycle_status: 'active', investigation_origin: 'founder',
          refresh_interval_hours: refreshIntervalHours, max_autonomous_runs: mode === 'monitor' ? 48 : 8,
          max_autonomous_followups: mode === 'follow_until_resolved' ? 6 : 0,
        }).select('id,program_id,question,status,canonical_key,investigation_mode,lifecycle_status,refresh_interval_hours').single()
        if (inserted.error?.code === '23505') { question = await findCurrentQuestion(db, canonicalKey); reused = true }
        else if (inserted.error) throw inserted.error
        else question = inserted.data
        if (!question) throw new Error('Canonical research question could not be created.')
      } else {
        const currentMode = (question.investigation_mode ?? 'one_shot') as InvestigationMode
        const effectiveMode = MODE_WEIGHT[mode] > MODE_WEIGHT[currentMode] ? mode : currentMode
        const reactivated = await db.from('research_questions').update({
          investigation_mode: effectiveMode, lifecycle_status: 'active',
          refresh_interval_hours: effectiveMode === mode ? refreshIntervalHours : question.refresh_interval_hours,
          resolved_at: null, resolution_reason: null, max_autonomous_runs: effectiveMode === 'monitor' ? 48 : 8,
          max_autonomous_followups: effectiveMode === 'follow_until_resolved' ? 6 : 0,
        }).eq('id', question.id)
        if (reactivated.error) throw reactivated.error
        question = { ...question, investigation_mode: effectiveMode, lifecycle_status: 'active' }
      }

      if (!programTitle) {
        const { data: programRow, error: programError } = await db.from('research_programs').select('title').eq('id', question.program_id).eq('scope', 'operator').maybeSingle()
        if (programError) throw programError
        if (!programRow) throw new Error('Canonical research program is unavailable.')
        programTitle = programRow.title
      }

      const originInsert = await db.from('research_question_origins').insert({
        question_id: question.id, founder_user_id: context.actor.userId, source_workspace_id: origin.workspaceId,
        direct_thread_id: origin.threadId, inbound_message_id: String(inbound.id), original_wording: inbound.body.trim(),
        lead_text: lead, verification_question: verificationQuestion,
      })
      if (originInsert.error && originInsert.error.code !== '23505') throw originInsert.error

      const run = await queueResearchRun(question.id, 'founder_direct')
      const directRunId = currentDirectRunId()
      if (directRunId) {
        await linkDirectRunToResearch(db, { directRunId, questionId: question.id, researchRunId: run.id })
      }

      const effectiveMode = (question.investigation_mode ?? mode) as InvestigationMode
      return {
        status: 'staged',
        data: {
          durable: true, reused, epistemicStatus: 'unverified_lead', questionId: question.id,
          verificationQuestion: question.question, canonicalKey, program: programTitle,
          investigationMode: effectiveMode, refreshIntervalHours,
          runId: run.id, runStatus: run.status,
          next: effectiveMode === 'monitor'
            ? 'The initial research run is queued and this investigation will continue monitoring on an adaptive cadence.'
            : 'The initial research run is queued and Caye will autonomously revisit unresolved or contradictory evidence within the bounded investigation budget.',
        },
        evidence: [{ kind: 'record', id: `research_question:${question.id}` }, { kind: 'record', id: `research_run:${run.id}` }],
        executionRef: null, auditRef: `research_question:${question.id}`, failure: null,
      }
    } catch (error) {
      return failed('unavailable', error instanceof Error ? error.message : 'Research investigation could not be created.', true)
    }
  },
}
