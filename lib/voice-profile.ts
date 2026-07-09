import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

export interface VoiceProfile {
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
  // Verbatim block — literal strings preserved character-for-character.
  // Null when the extractor couldn't find a consistent reuse across samples.
  signature_block: string | null
  tagline: string | null
  standard_signoff: string | null
  standard_opener: string | null
  // Register override layered on at fetch time from
  // customers.voice_register_overrides (#54). Not extracted by the LLM —
  // these are set conversationally via update_voice_register.
  register_override?: string | null
  register_scope?: 'default' | 'b2b' | 'vip' | null
}

export async function extractVoiceProfile(samples: string[]): Promise<VoiceProfile> {
  const client = new Anthropic()

  const samplesText = samples
    .map((s, i) => `--- Message ${i + 1} ---\n${s.trim()}`)
    .join('\n\n')

  const message = await loggedMessagesCreate(client, {
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    system: `Analyze these writing samples and extract the author's communication style AND any literal strings they reuse verbatim.
Return ONLY valid JSON — no markdown, no explanation:
{
  "writing_style": "2-3 sentences describing sentence length, formality, and structure",
  "common_phrases": ["phrases", "this", "person", "uses", "often"],
  "greeting_style": "how they typically open messages",
  "signoff_style": "how they typically close or sign off",
  "formality_level": "casual",
  "tone_notes": "notable tone characteristics such as direct, empathetic, brief, enthusiastic",
  "signature_block": "EXACT multi-line signature as it appears at the bottom of their emails, preserving line breaks with \\n. Do NOT paraphrase. Do NOT include greeting/signoff lines like 'Best regards' — only the identity block below them. Null if no consistent signature appears in 3+ samples.",
  "tagline": "EXACT tagline string if one appears in 3+ samples, for example: Where Every Tour Tells a Story. Do NOT paraphrase. Do NOT wrap it in quote marks — return the bare phrase, even if the person's own emails happen to display it with quotes around it. Null if no consistent tagline.",
  "standard_signoff": "EXACT closing line used most frequently before the signature, for example: Best regards, or Thanks,. Do NOT wrap it in quote marks. Null if signoff varies.",
  "standard_opener": "EXACT opening line if used in 50%+ of samples. Do NOT wrap it in quote marks. Null if openers vary widely."
}
Rules:
- The formality_level field must be exactly one of: "casual", "warm-professional", or "formal".
- For the four verbatim fields (signature_block, tagline, standard_signoff, standard_opener): preserve case, punctuation, and line breaks exactly. If you would have to paraphrase to fit, return null.
- NEVER wrap tagline, standard_signoff, or standard_opener in quote marks (" or ') as part of the returned value, even if the source text visually displays them quoted — those are JSON string values, not display text. If the person's signature_block itself contains a quoted line (e.g. a quoted tagline as the last line of their sign-off), preserve those quote marks only inside signature_block, since that field is a literal reproduction of the block.
- A field is "verbatim" only if it appears in 3+ samples with identical wording. One-offs go in null.`,
    messages: [
      {
        role: 'user',
        content: `Analyze these writing samples and extract the voice profile:\n\n${samplesText}`,
      },
    ],
  }, { source: 'lib/voice-profile.ts:extractVoiceProfile' })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const profile = JSON.parse(text) as VoiceProfile

  // Defensive backstop, not just a prompt instruction: confirmed live that
  // the model can copy an example's quote-mark formatting literally into
  // the extracted value (tagline stored as `"Where Every Tour Tells a
  // Story"` — quotes baked into the string itself, not JSON delimiters).
  // That corrupts both the tagline instruction in buildSystem (produces
  // doubled quotes: `""...""`) and anything that string-matches against it
  // (ensureTagline). Strip wrapping quotes from the three standalone
  // verbatim fields; signature_block is left alone since a quoted line
  // there is a literal part of the person's actual signature.
  profile.tagline = stripWrappingQuotes(profile.tagline)
  profile.standard_signoff = stripWrappingQuotes(profile.standard_signoff)
  profile.standard_opener = stripWrappingQuotes(profile.standard_opener)

  return profile
}

export function stripWrappingQuotes(value: string | null): string | null {
  if (!value) return value
  const trimmed = value.trim()
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]
  for (const [open, close] of pairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length > open.length) {
      return trimmed.slice(open.length, -close.length).trim()
    }
  }
  return trimmed
}

/**
 * Deterministic backstop for the tagline instruction in buildSystem
 * (lib/caye-reply.ts) — that's a soft LLM instruction with no guarantee the
 * model actually includes it. Confirmed live: Karenda (Bimini Island Tours)
 * asked for "Where every tour tells a story" on every outbound email, and
 * it kept going missing. Called right before the actual send so it's
 * appended if the model didn't already include it (case-insensitive check —
 * don't double it up if the model did comply).
 */
export function ensureTagline(body: string, voiceProfile: VoiceProfile | undefined): string {
  // stripWrappingQuotes guards against already-corrupted stored data (a
  // tagline saved with literal quote marks baked into the string) even
  // after the extraction-time fix — old rows and the profile-refresh merge
  // in lib/owner-voice-learning.ts can both carry a bad value forward.
  const tagline = stripWrappingQuotes(voiceProfile?.tagline?.trim() ?? null)
  if (!tagline) return body
  if (body.toLowerCase().includes(tagline.toLowerCase())) return body
  return `${body.trimEnd()}\n\n${tagline}`
}
