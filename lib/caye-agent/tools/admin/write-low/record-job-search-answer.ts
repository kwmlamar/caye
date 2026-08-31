import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getActiveProfile, writeProfileFact } from '@/lib/job-search/profile'
import { greenhouseAtsProvider } from '@/lib/job-search/execution/providers/greenhouse'
import { inspectApplicationForHumanAssist } from '@/app/api/caye/job-search-inspect/route'
import type { ProfileFactCategory } from '@/lib/job-search/types'
import type { Tool } from '../../types'

type Input = { application_id: string; question: string; answer: string }

const SEMANTIC_KEY_TO_CATEGORY: Record<string, ProfileFactCategory> = {
  sponsorship: 'work_authorization',
  work_authorization: 'work_authorization',
  citizenship: 'citizenship',
  clearance: 'clearance',
  criminal_history: 'criminal_history',
  disability: 'disability',
  veteran_status: 'veteran',
  demographic: 'demographic',
  relocation: 'relocation',
  compensation: 'compensation',
  legal_attestation: 'attestation',
  willingness_to_travel: 'general',
  drivers_license: 'general',
  availability_start_date: 'general',
  background_check_acknowledgment: 'attestation',
  arbitration_acknowledgment: 'attestation',
  linkedin: 'general',
}

/**
 * Founder-only bridge from a direct conversational answer to the canonical
 * job-search fact store. The model may never invent the question/category:
 * both are re-discovered from the stored application's real ATS form and the
 * supplied question must match one discovered required field exactly.
 */
export const recordJobSearchAnswer: Tool<Input> = {
  name: 'record_job_search_answer',
  description:
    'Persist an explicit founder answer to an unresolved required job-application question. Use this immediately after the founder answers a question you just asked (for example Yes/No for work authorization). Requires the stored application ID and exact question text. This is an internal data update only; it never submits or contacts an employer. After it succeeds, continue the requested readiness/dry-run flow instead of asking for the same answer again.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    required: ['application_id', 'question', 'answer'],
    properties: {
      application_id: { type: 'string' },
      question: { type: 'string' },
      answer: { type: 'string' },
    },
  },

  async execute(args) {
    const applicationId = args.application_id.trim()
    const question = args.question.trim()
    const answer = args.answer.trim()
    if (!applicationId || !question || !answer) return { ok: false, error: 'application_id, question, and answer are required.' }

    try {
      const supabase = createServiceClient()
      const { data: application, error } = await supabase
        .from('job_search_applications')
        .select('id,status,candidate:job_search_candidates(company,title,apply_url)')
        .eq('id', applicationId)
        .maybeSingle()
      if (error || !application) return { ok: false, error: error?.message ?? 'Application not found.' }
      if (!['NEEDS_HUMAN', 'PREPARED'].includes(application.status as string)) {
        return { ok: false, error: `Refusing to change answers while application is ${application.status}.` }
      }

      const candidate = application.candidate as unknown as { company: string; title: string; apply_url: string } | null
      if (!candidate) return { ok: false, error: 'Candidate missing for application.' }

      const discovery = await greenhouseAtsProvider.discoverFields(candidate.apply_url)
      if (discovery.outcome !== 'clear') return { ok: false, error: `Could not safely re-discover the ATS form: ${discovery.reason}` }

      const normalizedQuestion = question.toLowerCase()
      const matches = discovery.fields.filter((field) => field.required && field.label.trim().toLowerCase() === normalizedQuestion)
      if (matches.length !== 1) {
        return { ok: false, error: matches.length === 0 ? 'That question is not an exact required field on the stored application.' : 'The ATS form has multiple required fields with that label; refusing to guess which one you answered.' }
      }

      const field = matches[0]
      if (!field.semanticKey) return { ok: false, error: 'That required field has no recognized semantic key, so the answer cannot be safely reused.' }
      const category = SEMANTIC_KEY_TO_CATEGORY[field.semanticKey]
      if (!category) return { ok: false, error: `Semantic key ${field.semanticKey} has no canonical fact category.` }

      let canonicalAnswer = answer
      if (field.allowedOptions?.length) {
        const normalizedAnswer = answer.toLowerCase()
        const optionMatches = field.allowedOptions.filter((option) =>
          option.label.trim().toLowerCase() === normalizedAnswer || option.value.trim().toLowerCase() === normalizedAnswer
        )
        if (optionMatches.length !== 1) {
          return { ok: false, error: `Answer must match exactly one offered option: ${field.allowedOptions.map((option) => option.label).join(' / ')}.` }
        }
        // Persist the human-readable label as the canonical fact. Resolution
        // later maps it back to the provider-specific option value.
        canonicalAnswer = optionMatches[0].label
      }

      const profile = await getActiveProfile()
      if (!profile) return { ok: false, error: 'Founder job-search profile missing.' }

      const written = await writeProfileFact({
        profileId: profile.id,
        canonicalKey: field.semanticKey,
        category,
        question: field.label,
        answer: canonicalAnswer,
        source: 'founder-direct',
        createdBy: 'caye-direct',
      })

      const inspection = await inspectApplicationForHumanAssist(applicationId)
      return {
        ok: true,
        data: {
          application_id: applicationId,
          company: candidate.company,
          title: candidate.title,
          question: field.label,
          answer: canonicalAnswer,
          semantic_key: field.semanticKey,
          profile_fact_id: written.id,
          inspection,
          note: 'Founder answer persisted. Do not ask for this same answer again unless the ATS field changes or the fact expires.',
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not persist founder application answer.' }
    }
  },
}
