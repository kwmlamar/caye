import type { StrategicIntelligencePriority } from '@/lib/intelligence/query'
import type { ResearchDeskDefinition, ResearchDeskQuestion } from './runtime'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Convert already-grounded graph state into bounded research questions for one
 * existing desk. This never forms relations or upgrades beliefs; it only tells
 * the canonical desk runtime which unresolved state deserves another evidence pass.
 */
export function graphPriorityQuestions(input: {
  desk: ResearchDeskDefinition
  priorities: StrategicIntelligencePriority[]
  recentQuestions: string[]
  limit: number
}): ResearchDeskQuestion[] {
  if (input.limit <= 0) return []
  const recent = new Set(input.recentQuestions.map(normalize))
  const deskDomain = normalize(input.desk.domain)
  const seen = new Set<string>()
  const output: ResearchDeskQuestion[] = []

  for (const priority of input.priorities) {
    if (!priority.domains.some((domain) => normalize(domain) === deskDomain)) continue
    const question = priority.statement.trim()
    const key = normalize(question)
    if (!question || recent.has(key) || seen.has(key)) continue
    seen.add(key)
    output.push({ question, mode: 'monitoring', depth: 0 })
    if (output.length >= input.limit) break
  }

  return output
}
