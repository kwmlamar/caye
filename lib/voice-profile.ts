import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

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
}

export async function extractVoiceProfile(samples: string[]): Promise<VoiceProfile> {
  const client = new Anthropic()

  const samplesText = samples
    .map((s, i) => `--- Message ${i + 1} ---\n${s.trim()}`)
    .join('\n\n')

  const message = await client.messages.create({
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
  "tagline": "EXACT tagline string if one appears in 3+ samples (example: \\"Where Every Tour Tells a Story\\"). Do NOT paraphrase. Null if no consistent tagline.",
  "standard_signoff": "EXACT closing line used most frequently before the signature (example: \\"Best regards,\\" or \\"Thanks,\\"). Null if signoff varies.",
  "standard_opener": "EXACT opening line if used in 50%+ of samples. Null if openers vary widely."
}
Rules:
- The formality_level field must be exactly one of: "casual", "warm-professional", or "formal".
- For the four verbatim fields (signature_block, tagline, standard_signoff, standard_opener): preserve case, punctuation, and line breaks exactly. If you would have to paraphrase to fit, return null.
- A field is "verbatim" only if it appears in 3+ samples with identical wording. One-offs go in null.`,
    messages: [
      {
        role: 'user',
        content: `Analyze these writing samples and extract the voice profile:\n\n${samplesText}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(text) as VoiceProfile
}
