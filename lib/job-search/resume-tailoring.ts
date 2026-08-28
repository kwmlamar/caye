/**
 * Job-search operator (#192) — truthful resume/cover-note tailoring.
 *
 * "Prefer keyword/order emphasis over invented claims" (issue Phase 5).
 * This module NEVER introduces a skill, employer, title, or claim that
 * isn't already present in the founder's verified profile/resume-variant
 * source material — it only reorders and emphasizes. `tailorResume`'s
 * output is structurally guaranteed to be traceable: `emphasizedSkills`
 * is computed as a filter over `profileSkills` (never unioned with
 * anything else), and `content` is built by string-templating verbatim
 * source text plus that filtered list — there is no code path that can
 * inject a token absent from the inputs.
 */
import type { JobSearchProfile } from './profile'

export type ResumeVariantSource = {
  variantKey: 'full_stack' | 'backend_platform' | 'ai_llm'
  title: string
  summary: string | null
  sections: Record<string, unknown>
}

export type TailoredResume = {
  content: string
  emphasizedSkills: string[]
  /** Every emphasized skill is drawn from this exact list — the assertion tests check against it directly. */
  sourceSkillPool: string[]
}

/**
 * Orders the founder's verified skills by relevance to a job's listed
 * skills (job-matching skills first, in the job's own order), without
 * ever adding a skill absent from sourceSkillPool.
 */
export function emphasizeSkills(sourceSkillPool: string[], candidateJobSkills: string[]): string[] {
  const jobSkillsLower = candidateJobSkills.map((s) => s.toLowerCase())
  const matching = sourceSkillPool.filter((skill) => jobSkillsLower.includes(skill.toLowerCase()))
  const rest = sourceSkillPool.filter((skill) => !jobSkillsLower.includes(skill.toLowerCase()))
  return [...matching, ...rest]
}

export function tailorResume(
  variant: ResumeVariantSource,
  profile: Pick<JobSearchProfile, 'skills' | 'summary'>,
  candidateJobSkills: string[],
): TailoredResume {
  const sourceSkillPool = profile.skills
  const emphasizedSkills = emphasizeSkills(sourceSkillPool, candidateJobSkills)

  const summaryLine = variant.summary ?? profile.summary ?? ''
  const skillsLine = emphasizedSkills.length > 0 ? `Relevant strengths for this role: ${emphasizedSkills.join(', ')}.` : ''

  const content = [summaryLine, skillsLine].filter(Boolean).join('\n\n')

  return { content, emphasizedSkills, sourceSkillPool }
}

export type CoverNoteInput = {
  companyName: string
  roleTitle: string
  emphasizedSkills: string[]
  summary: string
}

/** Optional, concise, truthful cover note — reuses the same tailored emphasis, never invents new claims. */
export function generateCoverNote(input: CoverNoteInput): string {
  const skillsPhrase = input.emphasizedSkills.length > 0 ? ` particularly ${input.emphasizedSkills.slice(0, 3).join(', ')}` : ''
  return [
    `I'm applying for the ${input.roleTitle} role at ${input.companyName}.`,
    `${input.summary}`.trim(),
    input.emphasizedSkills.length > 0 ? `My background includes experience with${skillsPhrase}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
