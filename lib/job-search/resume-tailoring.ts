/**
 * Job-search operator (#192) — truthful resume/cover-note tailoring.
 */
import type { JobSearchProfile } from './profile'

export type ResumeVariantSource = {
  variantKey: 'it_support' | 'full_stack' | 'backend_platform' | 'ai_llm'
  title: string
  summary: string | null
  sections: Record<string, unknown>
  status: 'needs_verification' | 'verified'
}

export type TailoredResume = {
  content: string
  emphasizedSkills: string[]
  sourceSkillPool: string[]
}

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
