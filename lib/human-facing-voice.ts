import { sanitizeDashes } from './sanitize-dashes'

/**
 * Shared writing contract for any prose Caye intentionally shows to a person.
 * Keep this separate from internal reasoning, tool payloads, schemas, and JSON.
 */
export const HUMAN_FACING_VOICE_INSTRUCTIONS = `
HUMAN-FACING WRITING:
- Write for a high-school reading level or easier. Use plain, everyday words.
- Keep the answer short and direct. Lead with the answer, decision, or next action.
- Prefer short sentences and short paragraphs. Remove filler, repetition, and unnecessary explanation.
- Avoid jargon. If a technical term is necessary, explain it in simple words the first time.
- Never use an em dash (—) or en dash (–). Use a period, comma, parentheses, or a simple hyphen instead.
- Preserve important facts, names, dates, prices, links, commitments, and safety details while simplifying the wording.
- These rules apply only to text a person will read. Do not simplify or rewrite internal reasoning, tool arguments, schemas, code, or structured JSON.
`

/**
 * Deterministic last-mile guard for prose that will be shown or sent to a person.
 * Prompt instructions improve readability; this function guarantees dash policy.
 */
export function sanitizeHumanFacingText(text: string): string {
  return sanitizeDashes(text).trim()
}
