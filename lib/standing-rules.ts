import 'server-only'
import { createServiceClient } from './supabase-server'
import type { ForcedEscalation } from './forced-escalation'
import { humanEscalationNote } from './forced-escalation'

/**
 * Owner-taught constraints, enforced deterministically before the front-desk
 * LLM runs. See briefs/standing-rules-plan.md.
 *
 * The distinction this module exists to make real:
 *   business_facts — knowledge. Prose in the prompt. Advisory.
 *   standing rules — constraints on Caye's own authority. Evaluated here,
 *                    pre-LLM, so there is no opportunity to disobey.
 *
 * Test for which one applies: if the model ignored this instruction, would a
 * customer receive something we cannot take back? Yes → rule. No → fact.
 *
 * Matching is deliberately dumb — literal, case-insensitive substring on a
 * word boundary. No regex, ever: an LLM-authored pattern eventually matches
 * everything (burying the owner) or nothing (silent failure), and both are
 * worse than a rule that only catches the phrasing the owner actually named.
 */

export interface StandingRule {
  id: string
  trigger_type: 'service_mention' | 'keyword'
  match_value: string
  /**
   * 'escalate' — the original action. Subject to standdown
   * (lib/standing-rule-standdown.ts) when the enquiry is fully answerable
   * from deterministic catalog/availability/pricing data.
   * 'owner_only' — a hard block, added for #88. Never eligible for
   * standdown; a match must halt autonomous outbound until the owner
   * explicitly resolves it. See lib/authorize-autonomous-outbound.ts.
   */
  action: 'escalate' | 'owner_only'
  route_to: 'owner' | 'founder' | 'both'
}

/**
 * Escape a literal phrase for use in a regex, then require word boundaries
 * around it. Boundaries matter: a keyword rule on "VIP" should not fire on
 * "vipassana", and a service rule on "Eat Like a Local" should still match
 * inside "the Eat Like a Local tour".
 */
export function buildMatcher(matchValue: string): RegExp {
  const trimmed = matchValue.trim()
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Anchor with \b only where the adjacent character is actually a word
  // character. \b is a transition between \w and \W, so "\bSunset (Private)\b"
  // can never match: the pattern ends in ')', and a boundary after it would
  // require a word character immediately following. Unconditional anchoring
  // silently breaks every rule whose phrase starts or ends in punctuation —
  // and a rule that never fires is the worst outcome available here, since
  // the owner believes they're covered.
  const prefix = /^\w/.test(trimmed) ? '\\b' : ''
  const suffix = /\w$/.test(trimmed) ? '\\b' : ''
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i')
}

export function ruleMatches(rule: Pick<StandingRule, 'match_value'>, body: string): boolean {
  return buildMatcher(rule.match_value).test(body)
}

/**
 * First matching rule, or null. Ordered by created_at at the query layer, so
 * "first" means oldest — a stable, explainable tiebreak rather than whichever
 * row Postgres happened to return. With one action type and owner routing,
 * a conflict between two rules is close to meaningless in v1; this becomes
 * load-bearing only if `action` ever expands (brief §5.6).
 */
export function findMatchingRule(rules: StandingRule[], body: string): StandingRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, body)) return rule
  }
  return null
}

/** Locked customer-facing string. Controlled enum, never LLM-generated —
 *  same posture as TEMPLATES in lib/forced-escalation.ts, so wording can't
 *  drift per-rule or per-call. */
const STANDING_RULE_TEMPLATE =
  "Thanks for reaching out — let me get this in front of the team and we'll be back to you shortly."

/**
 * Build the ForcedEscalation a matched rule produces. Deliberately the same
 * shape the hardcoded triggers return, so applyEscalation, the operator brief
 * and the caye_urgent_hold ping all work unchanged.
 */
export function buildStandingRuleEscalation(
  rule: StandingRule,
  body: string
): ForcedEscalation {
  const customerAsk = body.replace(/\s+/g, ' ').trim().slice(0, 100)
  const what = rule.trigger_type === 'service_mention' ? 'mentions' : 'says'
  return {
    trigger: 'standing_rule',
    category: 'policy',
    routeTo: rule.route_to,
    customerFacingMessage: STANDING_RULE_TEMPLATE,
    pingSummary: `${rule.match_value} — "${customerAsk}"`,
    internalContext: humanEscalationNote(
      `You asked me to always bring you anything that ${what} "${rule.match_value}", so I held this rather than answer it myself.`,
      body
    ),
  }
}

/**
 * Sticky escalation for a thread that already has an unresolved one.
 *
 * A standing rule matches the literal service name in the message that
 * triggered it — and nothing after. Delysia Weeks (2026-08-09) hit exactly
 * that seam: the Full Bimini rule caught her first message, the owner had
 * not yet decided, and her follow-up asked "What would solo be for the 4
 * hours (north and south)". No literal service name, so no rule match, so
 * the LLM answered autonomously and quoted $199/person — the shared rate,
 * for a party of one, on a tour that needs three. The owner found it four
 * minutes later and had to send a correction.
 *
 * The rule the owner thought she was buying was "you don't quote this tour
 * without me". Enforcing that only on the first message of a thread doesn't
 * deliver it. So: while the owner owes a decision on a thread, Caye's
 * authority on that thread stays suspended regardless of how the next
 * message is phrased.
 *
 * No second ping results — applyEscalation's open-escalation guard folds
 * this into the existing row (see lib/whatsapp/escalation.ts).
 */
export function buildStickyEscalation(body: string): ForcedEscalation {
  const customerAsk = body.replace(/\s+/g, ' ').trim().slice(0, 100)
  return {
    trigger: 'standing_rule',
    category: 'policy',
    routeTo: 'owner',
    customerFacingMessage: STANDING_RULE_TEMPLATE,
    pingSummary: `Follow-up while you decide — "${customerAsk}"`,
    internalContext: humanEscalationNote(
      "You already have a decision pending on this conversation, so I'm holding this new message too rather than answering on my own before you've responded to the first one.",
      body
    ),
  }
}

/**
 * Does this conversation already have an escalation the owner hasn't
 * answered? Gates buildStickyEscalation — see its docstring.
 */
export async function conversationHasOpenEscalation(
  conversationId: string | null | undefined
): Promise<boolean> {
  if (!conversationId) return false
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_escalations')
    .select('id')
    .eq('conversation_id', conversationId)
    .is('owner_responded_at', null)
    .is('expired_at', null)
    .limit(1)
    .maybeSingle()
  if (error) {
    // Fail OPEN, matching fetchStandingRules: a DB blip must not turn every
    // thread into an escalation and bury the owner.
    console.error('[standing-rules] open-escalation lookup failed:', error.message)
    return false
  }
  return !!data
}

async function queryStandingRules(
  workspaceId: string
): Promise<{ data: StandingRule[] | null; error: { message: string } | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_standing_rules')
    .select('id, trigger_type, match_value, action, route_to')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(100)
  return { data: data as StandingRule[] | null, error }
}

/** Active rules for a workspace, oldest first. */
export async function fetchStandingRules(workspaceId: string): Promise<StandingRule[]> {
  const { data, error } = await queryStandingRules(workspaceId)
  if (error) {
    // Fail OPEN on a read error, deliberately. A standing rule escalates
    // instead of replying; if the table is unreachable we lose enforcement
    // but Caye still answers the guest. The alternative — treating a DB
    // blip as "escalate everything" — would bury the owner during exactly
    // the incident where they can least afford noise.
    //
    // This posture is specific to the escalate path. The owner_only
    // authority gate (lib/authorize-autonomous-outbound.ts) has the
    // opposite requirement — see fetchStandingRulesOrThrow below — and
    // must NOT reuse this fail-open behavior.
    console.error('[standing-rules] fetch failed:', error)
    return []
  }
  return data ?? []
}

/**
 * Same query as fetchStandingRules, but fails CLOSED: a read error throws
 * instead of returning []. Exists solely for
 * lib/authorize-autonomous-outbound.ts's owner_only gate, where an
 * unreadable rules table must block autonomous outbound rather than silently
 * behave as "no rules configured" (#88 follow-up — uncertainty must not
 * permit an autonomous customer send).
 */
export async function fetchStandingRulesOrThrow(workspaceId: string): Promise<StandingRule[]> {
  const { data, error } = await queryStandingRules(workspaceId)
  if (error) {
    throw new Error(`standing rules fetch failed: ${error.message}`)
  }
  return data ?? []
}

/**
 * Fire-and-forget usage counter. Never awaited by the reply path — a failed
 * counter update must not cost a guest their reply.
 */
export function recordRuleFired(ruleId: string): void {
  const supabase = createServiceClient()
  supabase
    .rpc('increment_standing_rule_fired', { rule_id: ruleId })
    .then(({ error }) => {
      if (error) console.error('[standing-rules] fired-counter update failed:', error)
    })
}

/**
 * How many inbound customer messages in the last `days` would have matched
 * this rule — the guardrail from brief §5.1.
 *
 * The single most important part of this feature. A rule on a common word
 * ("private") can fire on a large share of inbound; an owner who gets buried
 * stops reading pings, which is strictly worse than no rule at all. Showing a
 * real number before activation turns an abstract rule into a volume the
 * owner can actually judge.
 *
 * Counted in TypeScript rather than SQL ILIKE so the preview uses the exact
 * same word-boundary matcher the reply path will use — an ILIKE '%private%'
 * preview would over-count against a matcher that requires boundaries, and a
 * preview that disagrees with enforcement is worse than none.
 */
export async function previewRuleVolume(
  workspaceId: string,
  matchValue: string,
  days = 90
): Promise<{ matches: number; scanned: number; days: number }> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = ((accounts ?? []) as { id: string }[]).map((a) => a.id)
  if (accountIds.length === 0) return { matches: 0, scanned: 0, days }

  const { data: convos } = await supabase
    .from('unified_conversations')
    .select('id')
    .in('connected_account_id', accountIds)
    .limit(2000)
  const convoIds = ((convos ?? []) as { id: string }[]).map((c) => c.id)
  if (convoIds.length === 0) return { matches: 0, scanned: 0, days }

  const { data: messages } = await supabase
    .from('unified_messages')
    .select('content')
    .in('conversation_id', convoIds)
    .eq('sender_type', 'customer')
    .gte('sent_at', since)
    .limit(5000)

  const rows = (messages ?? []) as { content: string | null }[]
  const matcher = buildMatcher(matchValue)
  const matches = rows.filter((m) => m.content && matcher.test(m.content)).length
  return { matches, scanned: rows.length, days }
}
