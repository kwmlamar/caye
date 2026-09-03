import 'server-only'
import { createServiceClient } from './supabase-server'

/**
 * "Stronger, separate fact" half of the tried_at fix (see lib/outreach-
 * click-classifier.ts for the "is this hit even human" half).
 *
 * outreach_leads.tried_at (gated by the classifier) means "a plausibly-
 * human hit landed on the tracked demo link". It does NOT mean a demo
 * conversation actually happened — the redirect target is a wa.me deep
 * link; nothing on this side of that redirect can see whether the visitor
 * actually sent the prefilled WhatsApp message. demo_confirmed_at
 * (20260903120000_outreach_demo_confirmation.sql) is that stronger fact,
 * and this module is how it WOULD get set.
 *
 * NOT WIRED UP. app/api/webhooks/whatsapp-operator/route.ts is the only
 * place that ever sees inbound WhatsApp text, and it is explicitly out of
 * scope for this change (production-critical shared infrastructure, owned
 * by a parallel change in the same feature area). This module exists so
 * that a follow-up, reviewed change to that webhook can import a
 * ready-made, already-tested matcher rather than inventing one inline.
 *
 * What that follow-up change would need to do, concretely:
 *
 *   1. Change the wa.me prefill text app/api/r/[token]/route.ts builds
 *      (currently the fixed string "Hi Caye! I'd like to try it.") to
 *      append buildDemoConfirmationRef(lead.demo_token) to it. This is a
 *      customer-facing message-content change — real prospects would see
 *      the extra ref text in the message WhatsApp prefills for them —
 *      which is exactly why it is not done here pre-emptively: shipping
 *      it now would change live message content for zero benefit until
 *      step 2 also ships. Bundle both in one reviewed PR.
 *   2. In app/api/webhooks/whatsapp-operator/route.ts's handleOneInbound,
 *      for a text message from an unrecognized phone (the `!allow`
 *      branch, before tryColdStartWorkspace/tryHandleDemoProspect —
 *      identifying the ref must not block real cold-start signup if the
 *      ref turns out to be stale/unmatched), call
 *      parseDemoConfirmationRef(message.text.body). If it returns a
 *      token, call confirmOutreachDemoClick(supabase, { demoToken: token,
 *      phone: normalized, at: new Date().toISOString() }) and log the
 *      result. This must be additive only — it must never return early
 *      or otherwise change what happens next in handleOneInbound; a
 *      prospect who clicks the demo link is still a real cold-start
 *      signup and must still get the normal onboarding flow.
 *   3. Confirming a demo does not need to feed sales_apply_lifecycle_event
 *      (lib/sales/lifecycle.ts) unless product wants demo_confirmed_at to
 *      also move the lead's funnel stage — that RPC's event enum lives in
 *      a migration outside this change's file ownership
 *      (20260814b_sales_lifecycle_state.sql), so extending it is a
 *      separate, reviewed decision, not a mechanical follow-on.
 */

/**
 * Bracketed, easy-to-strip-by-eye reference tag. Not cryptographically
 * hidden — demo_token is already unguessable (12 hex chars, unique per
 * lead) and is not a secret (it is already visible in the tracked link
 * URL itself), so there is no confidentiality property to preserve here,
 * only "cheap to parse back out of free-form WhatsApp message text".
 */
const REF_PREFIX = '[ref:'
const REF_SUFFIX = ']'
const REF_TOKEN_RE = /^[0-9a-f]{6,40}$/i

/** Pure. What a future prefill-text change would append — see module docstring. */
export function buildDemoConfirmationRef(demoToken: string): string {
  return `${REF_PREFIX}${demoToken}${REF_SUFFIX}`
}

/**
 * Pure. Extracts a demo_token-shaped ref from free-form inbound message
 * text, or null if none is present. Deliberately tolerant of the ref
 * appearing anywhere in the message (a prospect may edit the prefilled
 * text before sending, but is unlikely to delete a trailing bracketed
 * tag they don't recognize as meaningful).
 */
export function parseDemoConfirmationRef(text: string): string | null {
  const start = text.indexOf(REF_PREFIX)
  if (start === -1) return null
  const end = text.indexOf(REF_SUFFIX, start + REF_PREFIX.length)
  if (end === -1) return null
  const candidate = text.slice(start + REF_PREFIX.length, end).trim()
  return REF_TOKEN_RE.test(candidate) ? candidate : null
}

/**
 * Idempotent: a lead already confirmed is left alone (first confirmation
 * wins, matching the tried_at/recordSalesLifecycleEvent idempotency
 * pattern elsewhere in this feature). Returns applied:false for an
 * unknown token or an already-confirmed lead — both are normal, expected
 * outcomes for a caller, not error conditions.
 */
export async function confirmOutreachDemoClick(
  supabase: ReturnType<typeof createServiceClient>,
  input: { demoToken: string; phone: string; at?: string }
): Promise<{ applied: boolean }> {
  const { data: lead } = await supabase
    .from('outreach_leads')
    .select('id, demo_confirmed_at')
    .eq('demo_token', input.demoToken)
    .maybeSingle()

  if (!lead || lead.demo_confirmed_at) return { applied: false }

  const { error } = await supabase
    .from('outreach_leads')
    .update({
      demo_confirmed_at: input.at ?? new Date().toISOString(),
      demo_confirmed_phone: input.phone,
    })
    .eq('id', lead.id)
    .is('demo_confirmed_at', null)

  if (error) {
    console.error(`[outreach-click-demo-confirmation] failed to confirm lead ${lead.id}:`, error.message)
    return { applied: false }
  }
  return { applied: true }
}
