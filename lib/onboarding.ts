import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'

export interface OnboardingQuestion {
  id: string
  field: string
  question: string
  suggestedAnswer: string
}

export interface BusinessProfile {
  system_prompt: string
  tone: string
  pricing_info: string
  common_questions: string[]
  cancellation_policy: string
  escalation_rules: string
  never_say: string
  voice_profile?: VoiceProfile
}

export const SERVICE_BUSINESS_QUESTIONS: OnboardingQuestion[] = [
  {
    id: 'identity',
    field: 'business_identity',
    question: 'What does your business do and where do you operate?',
    suggestedAnswer:
      "We're a service business offering [what you do] in [location]. Our jobs typically take [X hours/days] and we work with [X] clients at a time.",
  },
  {
    id: 'offerings',
    field: 'offerings',
    question: 'What are your main services or offerings?',
    suggestedAnswer:
      'Our most popular services are [list them]. We offer them [daily/on-demand/by quote].',
  },
  {
    id: 'pricing',
    field: 'pricing_booking',
    question: 'How do clients inquire or book, and what does it cost?',
    suggestedAnswer:
      'Services start at $[X] per client. Clients can reach us by replying to this message, WhatsApp, or visiting [link]. We require [deposit/full payment] to confirm.',
  },
  {
    id: 'faq',
    field: 'common_questions',
    question: 'What do clients ask most before starting a job or booking?',
    suggestedAnswer:
      "Most clients ask about what's included, how long it takes, what they need to prepare, and what happens if they need to reschedule.",
  },
  {
    id: 'tone',
    field: 'tone',
    question: 'How should Caye sound when talking to your clients?',
    suggestedAnswer:
      "Warm, friendly, and professional — like someone who genuinely cares about the client's experience. Not too stiff.",
  },
  {
    id: 'never_say',
    field: 'never_say',
    question: "Is there anything Caye should never promise or mention?",
    suggestedAnswer:
      "Never guarantee specific outcomes, never quote prices without checking current rates, never confirm availability without checking the schedule.",
  },
  {
    id: 'cancellations',
    field: 'cancellation_policy',
    question: "What's your cancellation or change policy, and what should Caye say when something goes wrong?",
    suggestedAnswer:
      'Full refund if cancelled 48 hours before. Caye should apologize sincerely and offer to reschedule or find a solution immediately.',
  },
  {
    id: 'escalation',
    field: 'escalation_rules',
    question: 'When should Caye hand off to a real person?',
    suggestedAnswer:
      "If a client is upset, if someone is asking about a large custom request over $[X], or if Caye isn't confident in the answer.",
  },
]

export async function buildBusinessProfile(
  answers: Record<string, string>,
  businessName: string
): Promise<BusinessProfile> {
  const client = new Anthropic()

  const answersText = SERVICE_BUSINESS_QUESTIONS.map(
    (q) => `${q.question}\nAnswer: ${answers[q.id] || answers[q.field] || '(not provided)'}`
  ).join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are building an AI configuration profile for a service business's AI receptionist named Caye.
Given the owner's answers to onboarding questions, extract and synthesize the information into a structured JSON profile.
Return ONLY valid JSON matching this exact shape — no markdown, no explanation:
{
  "system_prompt": "A detailed system prompt (3-5 sentences) that tells Caye who it is, what business it represents, its tone, and its core purpose. Written in second person (You are Caye...).",
  "tone": "One concise sentence describing the voice and tone.",
  "pricing_info": "A clear summary of pricing and booking process.",
  "common_questions": ["array", "of", "5-8", "specific", "FAQ", "items"],
  "cancellation_policy": "The cancellation and change policy in plain language.",
  "escalation_rules": "Clear rules for when to hand off to a human.",
  "never_say": "Things Caye must never say or promise."
}`,
    messages: [
      {
        role: 'user',
        content: `Business name: ${businessName}\n\nOnboarding answers:\n\n${answersText}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(text) as BusinessProfile
}

export async function saveBusinessProfile(
  workspaceId: string,
  profile: BusinessProfile,
  rawAnswers: Record<string, string>
): Promise<{ error: string | null }> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        system_prompt: profile.system_prompt,
        tone: profile.tone,
        pricing_info: profile.pricing_info,
        common_questions: profile.common_questions,
        cancellation_policy: profile.cancellation_policy,
        escalation_rules: profile.escalation_rules,
        never_say: profile.never_say,
        raw_onboarding_answers: rawAnswers,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  if (error) return { error: error.message }

  if (profile.voice_profile) {
    await supabase
      .from('customers')
      .update({ ai_voice_profile: profile.voice_profile })
      .eq('id', workspaceId)
  }

  await supabase
    .from('customers')
    .update({ has_onboarded: true })
    .eq('id', workspaceId)

  return { error: null }
}
