import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

export interface DiscoveryTurn {
  question: string
  answer: string
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

// Always the first thing Caye asks — deterministic, no LLM call needed to
// decide it. Everything after this is adaptive (see decideNextDiscoveryStep).
export const FIRST_DISCOVERY_QUESTION = "What's your business called?"

// Grill-me-style ceiling: never ask more than this many questions total
// (including the fixed business-name one), no matter how thin the
// signal — wrap up with what's there rather than exhaust the owner.
export const MAX_DISCOVERY_QUESTIONS = 10

export type DiscoveryStep =
  | { done: true }
  | { done: false; question: string; suggestedAnswer: string }

/**
 * Decides whether Caye has enough to build a solid profile yet, and if
 * not, what the single highest-value next question is. Mirrors the
 * grill-me skill's approach: ask one thing at a time, skip anything
 * already answered or reasonably inferable, stop as soon as there's
 * enough rather than working through a fixed script.
 */
export async function decideNextDiscoveryStep(
  businessName: string,
  turns: DiscoveryTurn[]
): Promise<DiscoveryStep> {
  try {
    const client = new Anthropic()
    const transcript = turns.map((t) => `${t.question}\nAnswer: ${t.answer}`).join('\n\n')

    const message = await loggedMessagesCreate(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: `You are Caye, an AI receptionist, interviewing a small-business owner over WhatsApp to learn how to represent their business. You need enough to: know what the business does and its tone, answer common customer questions, explain pricing/booking, know the cancellation policy, and know when to hand off to a human.

Ask ONE thing at a time. Prefer the fewest, highest-value questions — if an earlier answer already covers a topic (even partially), don't ask a dedicated question for it, infer it instead. Never ask something you could reasonably infer. The owner is busy and likely on their phone, so keep questions short and give a brief example answer to lower their effort.

They've answered ${turns.length} question(s) so far (including their business name). Keep the total under ${MAX_DISCOVERY_QUESTIONS} — wrap up ("done": true) once you have enough for a solid profile, even if some minor detail is still unknown.

Return ONLY valid JSON, no markdown, no explanation:
{"done": boolean, "question": "string or null — the single next question, only if done is false", "suggested_answer": "string or null — a short example answer, only if done is false"}`,
      messages: [
        {
          role: 'user',
          content: `Business name: ${businessName}\n\nConversation so far:\n\n${transcript}`,
        },
      ],
    }, { source: 'lib/onboarding.ts:decideNextDiscoveryStep' })

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(text) as { done: boolean; question: string | null; suggested_answer: string | null }

    if (parsed.done || !parsed.question) return { done: true }
    return { done: false, question: parsed.question, suggestedAnswer: parsed.suggested_answer ?? '' }
  } catch (err) {
    // Finish rather than get stuck — an unanswerable turn should never
    // mean the owner's message just vanishes with no reply.
    console.error('[onboarding] decideNextDiscoveryStep failed, finalizing early:', err)
    return { done: true }
  }
}

export async function buildBusinessProfile(
  turns: DiscoveryTurn[],
  businessName: string
): Promise<BusinessProfile> {
  const client = new Anthropic()

  const answersText = turns.map((t) => `${t.question}\nAnswer: ${t.answer}`).join('\n\n')

  const message = await loggedMessagesCreate(client, {
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
  }, { source: 'lib/onboarding.ts:buildBusinessProfile' })

  const raw = message.content[0].type === 'text' ? message.content[0].text : ''
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(text) as BusinessProfile
}

export async function saveBusinessProfile(
  workspaceId: string,
  profile: BusinessProfile,
  rawAnswers: DiscoveryTurn[]
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
