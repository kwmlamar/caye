import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { matchServiceByName } from '@/lib/services/match-service'
import type { Tool } from '../types'

interface AddServiceAvailabilityRuleInput {
  service_name: string
  effect: 'unavailable' | 'departure_minimum'
  weekday?: number | null
  min_party?: number | null
  note?: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Teach Caye when a tour can and cannot actually run.
 *
 * The third teaching verb, and the description below has to make the
 * three-way boundary decidable at call time:
 *   add_business_fact              — knowledge. Advisory prose.
 *   add_standing_rule              — "bring this to me." Suspends Caye's authority.
 *   add_service_availability_rule  — "this tour can/can't run then." A calendar
 *                                    fact with a headcount, checked before the
 *                                    model writes anything.
 *
 * On 2026-08-09 Mrs. Max taught two rules of the third kind and both were
 * filed as the first, because the first was the only tool that could hold
 * them. There is no settings page to add one instead — the operating model
 * forbids it — so this tool is the only route.
 */
export const addServiceAvailabilityRule: Tool<AddServiceAvailabilityRuleInput> = {
  name: 'add_service_availability_rule',
  description:
    "Save WHEN a tour can and cannot actually run — checked in code before you write any reply, so you can never quote a date the tour doesn't operate.\n\n" +
    "Two kinds, and picking the wrong one has real consequences:\n\n" +
    "effect='unavailable' — a HARD block. The tour cannot be sold for that day. " +
    "Set weekday for a recurring closure (0=Sunday .. 6=Saturday). Set min_party if a big enough " +
    "group lifts the block: \"no Full Bimini on Sundays unless it's 6 or more\" is " +
    "weekday=0, min_party=6.\n\n" +
    "effect='departure_minimum' — NOT a block. The tour still gets quoted and the spot still gets " +
    "reserved; it just needs those numbers to actually go ahead, and every quote below the minimum " +
    "has to say so. \"the minimum is 3 to 4 people\" is min_party=3. Filing this as 'unavailable' " +
    "would make you refuse solo travellers the owner wants you booking — do not do that.\n\n" +
    "CHOOSING BETWEEN THIS AND THE OTHER TWO:\n" +
    "- Is it about a DAY or a HEADCOUNT for a specific tour? → this tool.\n" +
    "- Is it \"bring this to me\" regardless of when? → add_standing_rule.\n" +
    "- Is it anything else the business knows? → add_business_fact.\n\n" +
    "Examples: \"we don't do the heritage tour on Mondays\" → this, effect='unavailable', weekday=1. " +
    "\"sunset tours need at least 4 people\" → this, effect='departure_minimum', min_party=4. " +
    "\"the meeting point is the pink building\" → add_business_fact. " +
    "\"bring me any VIP request\" → add_standing_rule.\n\n" +
    "Quote the owner's own words in `note` — it becomes the reason a guest is given, so it should " +
    "sound like the business, not like a system message.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      service_name: {
        type: 'string',
        description:
          'The tour this applies to, as it appears in the catalog. Call get_services first if unsure — a name that does not match is rejected rather than guessed at.',
      },
      effect: {
        type: 'string',
        enum: ['unavailable', 'departure_minimum'],
        description:
          "'unavailable' = cannot run at all that day. 'departure_minimum' = can be quoted and reserved, but needs this many guests to go ahead.",
      },
      weekday: {
        type: 'number',
        description:
          'Day of week this applies to: 0=Sunday, 1=Monday .. 6=Saturday. Omit for every day (the usual case for a departure_minimum).',
      },
      min_party: {
        type: 'number',
        description:
          "For 'unavailable': the group size that LIFTS the block (omit if nothing lifts it). For 'departure_minimum': the guests needed to run — REQUIRED.",
      },
      note: {
        type: 'string',
        description: "The owner's own words for why. Surfaced to guests as the reason.",
      },
    },
    required: ['service_name', 'effect'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    if (args.effect === 'departure_minimum' && !args.min_party) {
      return {
        ok: false,
        error:
          'A departure minimum needs a number — ask the owner how many guests the tour needs to run.',
      }
    }
    if (args.weekday != null && (args.weekday < 0 || args.weekday > 6)) {
      return { ok: false, error: `weekday must be 0-6 (0=Sunday). Got ${args.weekday}.` }
    }

    // Resolve against the real catalog rather than trusting the name. A rule
    // stored against a tour that doesn't exist never fires, and the owner
    // believes she is covered — the worst available outcome, same reasoning
    // as caye_standing_rules validating service_mention at write time.
    const { data: services } = await supabase
      .from('booking_services')
      .select('id, name')
      .eq('user_id', ctx.workspaceId)
      .eq('active', true)

    const candidates = ((services ?? []) as { id: string; name: string }[]).map((s) => ({
      id: s.id,
      name: s.name,
    }))
    const match = matchServiceByName(candidates, args.service_name)
    if (!match.best || match.confidence !== 'high') {
      return {
        ok: false,
        error:
          `Not confident which tour "${args.service_name}" means` +
          (match.candidates.length
            ? ` — closest are: ${match.candidates.map((c) => c.service.name).join(', ')}. Ask which one.`
            : '. Call get_services and ask the owner to pick one.'),
      }
    }

    const { data, error } = await supabase
      .from('service_availability_rules')
      .upsert(
        {
          workspace_id: ctx.workspaceId,
          service_id: match.best.id,
          weekday: args.weekday ?? null,
          effect: args.effect,
          min_party: args.min_party ?? null,
          note: args.note?.trim() || null,
          // Provenance is the role plus the allowlist row, matching how other
          // back-office tools identify the human (see ToolContext) — there is
          // no display name on the context to use here.
          created_by: `${ctx.callerRole}${ctx.operatorId != null ? ` #${ctx.operatorId}` : ''}`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id,service_id,weekday,effect' }
      )
      .select('id')
      .maybeSingle()

    if (error) return { ok: false, error: error.message }

    const scope =
      args.weekday != null ? `${WEEKDAYS[args.weekday]}s` : 'every day'
    const summary =
      args.effect === 'unavailable'
        ? `${match.best.name} will not be offered on ${scope}` +
          (args.min_party ? ` for parties under ${args.min_party}` : '') +
          '.'
        : `${match.best.name} quotes below ${args.min_party} guests will now always carry the departure-minimum caveat.`

    return {
      ok: true,
      data: {
        rule_id: data?.id ?? null,
        service: match.best.name,
        effect: args.effect,
        weekday: args.weekday ?? null,
        min_party: args.min_party ?? null,
        summary,
        applies_to:
          'Enquiries that state a tour, a date and a party size — which is what the website booking form sends.',
      },
    }
  },
}
