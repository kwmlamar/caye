import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { sendFreeFormWhatsApp, sendTemplateWhatsApp, deliveryFieldsFromResult } from '@/lib/whatsapp/outbound'
import { findDemoReplyLeak, demoRetryInstruction } from '@/lib/caye-demo-guard'
import { withDemoBusinessFacts } from '@/lib/caye-demo-context'

/**
 * Operator-initiated demo-roleplay mode (2026-07-22). Lets an
 * already-onboarded operator (owner/staff/founder) preview Caye's
 * guest-facing voice in the SAME WhatsApp thread they onboarded on,
 * by roleplaying as if they were one of their own customers.
 *
 * Distinct from the sales demo (tryHandleDemoProspect in the
 * whatsapp-operator webhook), which is a founder-led tool for cold,
 * unregistered phones with no operator_allowlist row.
 *
 * Deliberately does NOT reuse lib/caye-reply.ts (the live front-desk
 * engine real guests hit) or its tool-calling machinery — that file
 * has no dry-run concept, and threading one through it risks the one
 * code path a real paying customer's real guests depend on today.
 * Instead this is a small, isolated single-completion call: Caye
 * narrates what she'd do rather than actually executing bookings/
 * escalations, so there is zero code-path overlap with real guest
 * traffic and zero chance of a demo turn creating a real side effect.
 */

const DEMO_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEMO_OFFER_TEMPLATE = 'caye_demo_offer'
const DEMO_ENTRY_RE = /^demo$/i
// Bare command ("stop", "done") OR any phrase containing "<verb> (the) demo"
// ("stop demo", "how to stop demo", "exit the demo please"). Confirmed live
// 2026-07-27: the old exact-full-string match (`/^(stop demo|exit demo|end
// demo|done)$/i`) missed plain "Stop" and "How to stop demo" alike, so both
// fell through to generateDemoReply — which then broke character trying to
// answer a meta-question about the demo itself while still in the guest-
// facing business persona ("I'm just the AI... reach out to whoever set up
// your KWM Industries bot"). Matching on substring rather than requiring an
// exact match means a real guest-roleplay message that merely mentions
// "demo" mid-sentence could false-positive and end the session early — an
// acceptable trade since this is an operator-only preview tool, not
// customer-facing, and ending early just means typing "demo" again.
const DEMO_EXIT_BARE_RE = /^(stop|exit|end|done|quit|cancel)$/i
const DEMO_EXIT_PHRASE_RE = /\b(stop|exit|end|quit|cancel)\s+(the\s+)?demo\b/i

export function isDemoEntryKeyword(text: string): boolean {
  return DEMO_ENTRY_RE.test(text.trim())
}

export function isDemoExitKeyword(text: string): boolean {
  const trimmed = text.trim()
  // Trailing punctuation only for the bare check ("Stop." / "Done!") — the
  // phrase check doesn't need it since \b already stops at punctuation.
  const bareNoPunct = trimmed.replace(/[.!?]+$/, '')
  return DEMO_EXIT_BARE_RE.test(bareNoPunct) || DEMO_EXIT_PHRASE_RE.test(trimmed)
}

export const DEMO_INTRO_MESSAGE =
  "🎭 Demo started — I'll respond exactly as I would to one of your own guests. Say whatever you imagine a guest asking. Type \"stop demo\" anytime to end it (or it'll time out after 30 min of silence)."

export const DEMO_EXIT_MESSAGE =
  "Ending the demo here — back to normal! Type \"demo\" anytime to try it again."

export interface DemoSession {
  id: string
  workspace_id: string
  operator_allowlist_id: number | null
  phone: string
  message_count: number
}

interface DemoSessionRow extends DemoSession {
  last_activity_at: string
}

/**
 * Returns the operator's active demo session, if any. Lazily enforces
 * the idle timeout: a stale session is closed out here (no cron/
 * background job) and null is returned so the caller treats the
 * message as normal, not as a demo turn.
 */
export async function getActiveDemoSession(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  operatorAllowlistId: number
): Promise<DemoSession | null> {
  const { data } = await supabase
    .from('demo_sessions')
    .select('id, workspace_id, operator_allowlist_id, phone, last_activity_at, message_count')
    .eq('workspace_id', workspaceId)
    .eq('operator_allowlist_id', operatorAllowlistId)
    .is('ended_at', null)
    .maybeSingle()

  if (!data) return null
  const row = data as DemoSessionRow

  const idleMs = Date.now() - new Date(row.last_activity_at).getTime()
  if (idleMs > DEMO_IDLE_TIMEOUT_MS) {
    await endDemoSession(supabase, row.id, 'idle_timeout')
    return null
  }
  return row
}

export async function startDemoSession(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  operatorAllowlistId: number,
  phone: string
): Promise<DemoSession> {
  const { data, error } = await supabase
    .from('demo_sessions')
    .insert({ workspace_id: workspaceId, operator_allowlist_id: operatorAllowlistId, phone })
    .select('id, workspace_id, operator_allowlist_id, phone, message_count')
    .single()
  if (error || !data) throw new Error(`startDemoSession: ${error?.message}`)
  return data as DemoSession
}

export async function endDemoSession(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  reason: 'keyword' | 'idle_timeout'
): Promise<void> {
  await supabase
    .from('demo_sessions')
    .update({ ended_at: new Date().toISOString(), exit_reason: reason })
    .eq('id', sessionId)
}

export interface DemoTurn {
  role: 'guest' | 'caye'
  body: string
}

export async function loadDemoHistory(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string
): Promise<DemoTurn[]> {
  const { data } = await supabase
    .from('demo_session_messages')
    .select('role, body')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(60)
  return (data ?? []) as DemoTurn[]
}

/** Persists both turns of one roleplay exchange and bumps session activity/count. */
export async function advanceDemoSession(
  supabase: ReturnType<typeof createServiceClient>,
  session: DemoSession,
  guestBody: string,
  cayeBody: string
): Promise<void> {
  await supabase.from('demo_session_messages').insert([
    { session_id: session.id, role: 'guest', body: guestBody },
    { session_id: session.id, role: 'caye', body: cayeBody },
  ])
  await supabase
    .from('demo_sessions')
    .update({
      last_activity_at: new Date().toISOString(),
      message_count: session.message_count + 1,
    })
    .eq('id', session.id)
}

function demoSystemPrompt(realSystemPrompt: string, businessName: string, businessFactsBlock: string): string {
  return `${withDemoBusinessFacts(realSystemPrompt, businessFactsBlock)}

---
DEMO MODE — this section overrides nothing above except as noted here.
The person messaging you right now is ${businessName}'s own operator, previewing what a real guest would experience. They are role-playing as their own customer, not messaging you as themselves. Stay fully in character as the guest-facing version of yourself described above and respond exactly as you would to a real guest.

EXCEPTION — how actions work here: nothing you say has a real side effect, because this is a preview. That is a detail about this preview, NOT a limitation on the character you are playing. The Caye being previewed books, reschedules, cancels and escalates herself. So do the same: when a guest asks to book, TAKE the booking — collect whatever you still need in your own words, then state it as done, exactly as the live version would. Then add one separate short line starting with "→" noting what would really happen, e.g.: → In a live chat, this creates a real booking and notifies the owner. That "→" line is the only thing marking it as simulated; never imply a real action succeeded without it.

NEVER hand the guest off as a substitute for doing the job. Do not tell them to WhatsApp, call, text, email or otherwise contact the owner, a staff member, or any other number or channel to finish what you could finish yourself. You are the one handling it. (Genuinely out-of-scope matters can still be escalated — say you're passing it to the owner and that they'll follow up, then use the "→" line. That is different from telling the guest to go do it themselves.)

NEVER write a placeholder in brackets — no [your number here], [name], [link], or anything like it. You have no real phone numbers, links, or staff names to insert, so write replies that don't need them.

Keep replies concise, WhatsApp-length.`
}

/**
 * Generates one demo-roleplay reply. A single Claude completion, not a
 * tool loop — see file-level comment for why. Falls back to a generic
 * apology on any failure rather than throwing, since a thrown error
 * here would otherwise leave the operator's demo message unanswered.
 *
 * Retries once if the reply punts the guest to a human or leaks a
 * bracketed placeholder (see lib/caye-demo-guard.ts). The demo is the
 * surface that convinces an owner Caye can do the job, so a reply telling
 * their guest to go message someone else is worth one more call to fix.
 */
export async function generateDemoReply(
  systemPrompt: string,
  businessName: string,
  history: DemoTurn[],
  guestMessage: string,
  businessFactsBlock = ''
): Promise<string> {
  try {
    const client = new Anthropic()
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({
        role: (t.role === 'guest' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: t.body,
      })),
      { role: 'user', content: guestMessage },
    ]
    const baseSystem = demoSystemPrompt(systemPrompt, businessName, businessFactsBlock)

    const complete = async (system: string): Promise<string> => {
      const response = await loggedMessagesCreate(
        client,
        { model: 'claude-sonnet-4-6', max_tokens: 512, system, messages },
        { source: 'lib/caye-demo.ts:generateDemoReply' }
      )
      const block = response.content[0]
      return block?.type === 'text' ? block.text.trim() : ''
    }

    const first = await complete(baseSystem)
    if (!first) return "Sorry, let me try that again in a moment?"

    const leak = findDemoReplyLeak(first)
    if (!leak) return first

    console.warn(`[caye-demo] demo reply had a "${leak}" leak — retrying once`)
    const retried = await complete(baseSystem + demoRetryInstruction(leak))
    if (!retried) return first

    // Still bad after the nudge: send it anyway rather than leave the
    // operator hanging, but make sure it shows up in logs.
    const retryLeak = findDemoReplyLeak(retried)
    if (retryLeak) {
      console.error(`[caye-demo] demo reply still had a "${retryLeak}" leak after retry`)
    }
    return retried
  } catch (err) {
    console.error('[caye-demo] generateDemoReply failed:', err)
    return "Sorry, I hit a snag there — try that again in a moment?"
  }
}

/**
 * Offers the demo right after onboarding completes. Checks
 * whatsapp_templates.status at send time (not cached) — mirrors
 * morningDigestSupports4Placeholders in the outbound worker — and
 * falls back to a plain-text offer while the caye_demo_offer template
 * (with its "Demo" / "No thanks" quick-reply buttons, configured
 * directly in Meta Business Manager) is still pending Meta approval.
 * Best-effort: a failure here must never block onboarding.
 */
export async function sendDemoOffer(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  phone: string,
  businessName: string,
  operator: { id: number; name: string | null; role: string }
): Promise<void> {
  try {
    const { data } = await supabase
      .from('whatsapp_templates')
      .select('status')
      .eq('name', DEMO_OFFER_TEMPLATE)
      .maybeSingle()

    const offerText = `Want to see how I'll sound to your guests, ${businessName}? Reply "demo" and I'll roleplay as if you're one of your own customers.`

    const result =
      data?.status === 'approved'
        ? await sendTemplateWhatsApp(
            phone,
            DEMO_OFFER_TEMPLATE,
            [businessName],
            `demo-offer-${workspaceId}`
          )
        : await sendFreeFormWhatsApp(phone, offerText, `demo-offer-${workspaceId}`)

    if (result.status === 'failed') {
      console.error(`[caye-demo] demo offer send failed for workspace=${workspaceId}:`, result.error)
    }

    // Logged like any other onboarding message — this is a real message
    // Caye sent the operator, not a roleplay turn (those stay excluded,
    // see the block comment above route.ts's demo-mode branch), so it
    // belongs in the same back-office transcript as the rest of onboarding.
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction: 'outbound',
      ...deliveryFieldsFromResult(result),
      body: offerText,
      intent: null,
      operator_allowlist_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
    })
  } catch (err) {
    console.error(`[caye-demo] demo offer send threw for workspace=${workspaceId}:`, err)
  }
}
