import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

export interface VoiceProfile {
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
}

export async function extractVoiceProfile(samples: string[]): Promise<VoiceProfile> {
  const client = new Anthropic()

  const samplesText = samples
    .map((s, i) => `--- Message ${i + 1} ---\n${s.trim()}`)
    .join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `Analyze these writing samples and extract the author's communication style.
Return ONLY valid JSON — no markdown, no explanation:
{
  "writing_style": "2-3 sentences describing sentence length, formality, and structure",
  "common_phrases": ["phrases", "this", "person", "uses", "often"],
  "greeting_style": "how they typically open messages",
  "signoff_style": "how they typically close or sign off",
  "formality_level": "casual",
  "tone_notes": "notable tone characteristics such as direct, empathetic, brief, enthusiastic"
}
The formality_level field must be exactly one of: "casual", "warm-professional", or "formal".`,
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
