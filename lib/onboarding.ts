import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'

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
}

export const TOUR_OPERATOR_QUESTIONS: OnboardingQuestion[] = [
  {
    id: 'identity',
    field: 'business_identity',
    question: 'What does your business do and where do you operate?',
    suggestedAnswer:
      "We're a tour operator offering day trips and excursions in [location]. Our tours typically run [X] hours and accommodate groups of up to [X] people.",
  },
  {
    id: 'offerings',
    field: 'offerings',
    question: 'What are your main tours or experiences?',
    suggestedAnswer:
      'Our most popular tours are [snorkeling trips, island hops, sunset cruises]. We run them [daily/weekends/by request].',
  },
  {
    id: 'pricing',
    field: 'pricing_booking',
    question: 'How do people book and what does it cost?',
    suggestedAnswer:
      'Tours start at $[X] per person. Guests can book by replying to this message, WhatsApp, or visiting [link]. We require [deposit/full payment] to confirm.',
  },
  {
    id: 'faq',
    field: 'common_questions',
    question: 'What do guests ask most before booking?',
    suggestedAnswer:
      "Most guests ask about what's included, whether kids can join, what to bring, and what happens if weather is bad.",
  },
  {
    id: 'tone',
    field: 'tone',
    question: 'How should Caye sound when talking to your guests?',
    suggestedAnswer:
      "Warm, friendly, and enthusiastic — like a local who loves showing people around. Not too formal.",
  },
  {
    id: 'never_say',
    field: 'never_say',
    question: "Is there anything Caye should never promise or mention?",
    suggestedAnswer:
      "Never guarantee specific wildlife sightings, never quote prices without checking current rates, never confirm availability without checking the calendar.",
  },
  {
    id: 'cancellations',
    field: 'cancellation_policy',
    question: "What's your cancellation policy and what should Caye say when something goes wrong?",
    suggestedAnswer:
      'Full refund if cancelled 48 hours before. Weather cancellations get a free reschedule. Caye should apologize sincerely and offer to reschedule immediately.',
  },
  {
    id: 'escalation',
    field: 'escalation_rules',
    question: 'When should Caye hand off to a real person?',
    suggestedAnswer:
      "If a guest is upset, if someone is asking about a custom private booking over $[X], or if Caye isn't confident in the answer.",
  },
]

export async function buildBusinessProfile(
  answers: Record<string, string>,
  businessName: string
): Promise<BusinessProfile> {
  const client = new Anthropic()

  const answersText = TOUR_OPERATOR_QUESTIONS.map(
    (q) => `${q.question}\nAnswer: ${answers[q.id] || answers[q.field] || '(not provided)'}`
  ).join('\n\n')

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are building an AI configuration profile for a tour operator's AI receptionist named Caye.
Given the owner's answers to onboarding questions, extract and synthesize the information into a structured JSON profile.
Return ONLY valid JSON matching this exact shape — no markdown, no explanation:
{
  "system_prompt": "A detailed system prompt (3-5 sentences) that tells Caye who it is, what business it represents, its tone, and its core purpose. Written in second person (You are Caye...).",
  "tone": "One concise sentence describing the voice and tone.",
  "pricing_info": "A clear summary of pricing and booking process.",
  "common_questions": ["array", "of", "5-8", "specific", "FAQ", "items"],
  "cancellation_policy": "The cancellation and weather policy in plain language.",
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

  await supabase
    .from('customers')
    .update({ has_onboarded: true })
    .eq('id', workspaceId)

  return { error: null }
}
