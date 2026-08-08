import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { previewRuleVolume } from '@/lib/standing-rules'
import type { Tool } from '../types'

interface AddStandingRuleInput {
  trigger_type: 'service_mention' | 'keyword'
  match_value: string
  route_to?: 'owner' | 'founder' | 'both'
}

/**
 * Teach Caye a constraint that is ENFORCED, not suggested.
 * See briefs/standing-rules-plan.md.
 *
 * The counterpart to add_business_fact, and the tool description below is
 * written to make the boundary decidable by the model at call time. Getting
 * that boundary wrong in the "constraint filed as knowledge" direction is
 * how a package the owner prices herself got quoted to a customer
 * (2026-08-08); the reverse error just annoys her. So the guidance biases
 * toward rule on genuine ambiguity, and pairs it with the volume preview
 * so the cost of that bias is visible before anything is stored.
 */
export const addStandingRule: Tool<AddStandingRuleInput> = {
  name: 'add_standing_rule',
  description:
    "Save a HARD RULE about what you must not handle alone — enforced in code, not just remembered. " +
    "Use when the owner tells you to always bring something to them, or never handle something yourself: " +
    "\"bring Full Bimini bookings to me\", \"never quote group rates without asking\", " +
    "\"anything from a travel agent comes to me first\".\n\n" +
    "CHOOSING BETWEEN THIS AND add_business_fact — ask yourself: if you ignored this instruction, " +
    "would a customer receive something we can't take back?\n" +
    "- YES (a price quoted, a date held, a booking confirmed) → add_standing_rule. It's a constraint " +
    "on what you're allowed to do.\n" +
    "- NO (you'd just say something inaccurate, fixable in the next message) → add_business_fact. " +
    "It's knowledge.\n\n" +
    "Examples: \"the meeting point is the pink building\" → fact. \"we don't run tours in heavy rain\" " +
    "→ fact. \"bring VIP requests to me\" → rule. \"don't quote the sunset charter yourself\" → rule.\n\n" +
    "When in genuine doubt, prefer add_standing_rule — an unnecessary escalation is recoverable, " +
    "a price you shouldn't have sent is not.\n\n" +
    "trigger_type 'service_mention' is for a tour/service by name (must match the catalog exactly — " +
    "call get_services first if unsure). 'keyword' is for any other literal phrase. Matching is " +
    "literal and case-insensitive, so pick the words a guest would actually write.\n\n" +
    "IMPORTANT: this tool returns how many real messages in the last 90 days would have triggered " +
    "the rule. ALWAYS tell the owner that number in your reply and what it means week-to-week, so " +
    "they can judge whether they want that much traffic. If it looks high, say so and offer a " +
    "narrower phrase.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      trigger_type: {
        type: 'string',
        enum: ['service_mention', 'keyword'],
        description:
          "'service_mention' for a catalog service by name; 'keyword' for any other literal phrase.",
      },
      match_value: {
        type: 'string',
        description:
          'The exact phrase to watch for, as a guest would write it. For service_mention this must match a service name in the catalog.',
      },
      route_to: {
        type: 'string',
        enum: ['owner', 'founder', 'both'],
        description: "Who it goes to. Defaults to 'owner' — leave this out unless told otherwise.",
      },
    },
    required: ['trigger_type', 'match_value'],
  },

  async execute(args, ctx) {
    const matchValue = args.match_value.trim()
    if (matchValue.length < 3) {
      return { ok: false, error: 'That phrase is too short — it would match almost everything.' }
    }
    if (matchValue.length > 120) {
      return { ok: false, error: 'That phrase is too long to match reliably — use the few words a guest would actually write.' }
    }

    const supabase = createServiceClient()

    // service_mention validates against the real catalog. A typo would
    // otherwise create a rule that silently never fires — the worst
    // outcome here, since the owner believes they're protected.
    if (args.trigger_type === 'service_mention') {
      const { data: services } = await supabase
        .from('booking_services')
        .select('name')
        .eq('workspace_id', ctx.workspaceId)
      const names = ((services ?? []) as { name: string }[]).map((s) => s.name)
      const exact = names.find((n) => n.toLowerCase() === matchValue.toLowerCase())
      if (!exact) {
        return {
          ok: false,
          error:
            `"${matchValue}" isn't a service in the catalog. Available: ${names.join(', ') || '(none)'}. ` +
            `Use the exact name, or use trigger_type 'keyword' if you meant a general phrase.`,
        }
      }
    }

    const { data: existing } = await supabase
      .from('caye_standing_rules')
      .select('id')
      .eq('workspace_id', ctx.workspaceId)
      .eq('trigger_type', args.trigger_type)
      .eq('is_active', true)
      .ilike('match_value', matchValue)
      .maybeSingle()
    if (existing) {
      return { ok: false, error: `There's already an active rule for "${matchValue}" — nothing to change.` }
    }

    // Run the preview BEFORE inserting so a wildly over-broad rule can be
    // reported honestly even though it's now live. Brief §5.1.
    const volume = await previewRuleVolume(ctx.workspaceId, matchValue)

    const { data, error } = await supabase
      .from('caye_standing_rules')
      .insert({
        workspace_id: ctx.workspaceId,
        trigger_type: args.trigger_type,
        match_value: matchValue,
        action: 'escalate',
        route_to: args.route_to ?? 'owner',
        created_by: ctx.callerRole,
      })
      .select('id')
      .single()

    if (error) return { ok: false, error: `Could not save the rule: ${error.message}` }

    const perWeek = volume.days > 0 ? (volume.matches / (volume.days / 7)).toFixed(1) : '0'

    return {
      ok: true,
      data: {
        rule_id: data.id,
        match_value: matchValue,
        route_to: args.route_to ?? 'owner',
        enforcement:
          'Active now. Any inbound message matching this goes straight to the owner — Caye will not draft a reply, quote a price, or hold a date on it.',
        would_have_fired_last_90_days: volume.matches,
        approx_per_week: perWeek,
        messages_scanned: volume.scanned,
        tell_the_owner:
          `Say plainly what changed and give them the number: this would have fired ${volume.matches} times ` +
          `in the last 90 days (about ${perWeek} a week). If that sounds like a lot, offer a narrower phrase.`,
      },
    }
  },
}
