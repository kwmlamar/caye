/**
 * Attention items -> the operator who owns them.
 *
 * THE PROBLEM THIS FIXES
 *
 * ODS's audit found one man acting as the router for every decision,
 * document, payment and message in a business running eight to ten jobs at
 * once — "a saturated router". Every attention producer in this codebase
 * (`lib/domain-attention.ts`, `lib/freight-attention.ts`, and whatever reads
 * `lib/owner-attention.ts`'s ledger) raises an item, but none of them decide
 * WHO should see it. Delivering every item to the same person — however it
 * is raised — rebuilds the exact bottleneck in software.
 *
 * This module is that missing decision. It is pure: no Supabase, no I/O, no
 * `server-only`. Data in, decision out. A caller (a briefing composer, a
 * notifier) supplies the item, the workspace's verified operator roster, and
 * the workspace's role configuration; this module returns who gets it and
 * why, or says plainly that nobody does yet.
 *
 * WHY ROLE KEYS, NOT NAMES
 *
 * "Route the payroll alert to Jay" does not survive Jay leaving. The mapping
 * below goes from a domain (what kind of thing this is) to a ROLE — a job
 * function, not a person — and a second, workspace-held mapping resolves
 * that role to today's operator. Names change; the role a purchase order
 * belongs to does not. `resolveRoleOperatorId` is where that second mapping
 * lives, following the same shipped-default/workspace-override shape
 * `lib/domain-policy.ts` established for `domain_source_connections.config`.
 *
 * There genuinely is no safe shipped default for a role -> operator id
 * mapping, unlike `domain-policy.ts`'s crew-day numbers (a measured 60-minute
 * break generalizes across a construction business; nobody's actual operator
 * id does). So every role starts unmapped, and stays unrouted — never
 * silently defaulted to the owner — until a workspace configures it.
 */

import type { AttentionPriority } from '@/lib/owner-attention'

/** Mirrors `operator_allowlist` (workspace_id, phone, role, verified are the
 *  relevant columns; `role` there is the allowlist's own access role —
 *  'owner' | 'staff' | 'founder' — a different vocabulary from the
 *  `AttentionRoleKey` business-function roles this module resolves against). */
export interface RoutableOperator {
  id: number
  name: string | null
  phone: string
  role: string
  verified: boolean
}

/**
 * The business-function roles attention can be routed to. Job functions, not
 * people — see the module doc for why. Whoever currently holds a role is a
 * workspace configuration fact (`resolveRoleOperatorId`), never encoded here.
 */
export type AttentionRoleKey = 'owner' | 'estimator' | 'hr' | 'office'

/** One routable item. Enough to look up a rule and, where the rule escalates
 *  on priority, decide whether this instance qualifies. */
export interface RoutableAttentionItem {
  /** e.g. `SUBJECT_CONSTRUCTION_CHANGE`, `SUBJECT_FREIGHT_REQUEST`, `'receivable'`. */
  subjectType: string
  /** `payload.source.entity_type` for a `construction_change` item — project |
   *  estimate | purchase_order | receipt | pay_period. Irrelevant for subject
   *  types that don't branch on it (ignored if present). */
  entityType?: string | null
  /** Drives the escalation rules below. Absent is treated as "no priority
   *  known" — an item can't qualify for a priority-gated escalation without one. */
  priority?: AttentionPriority | null
}

export type RouteResult =
  | { operatorId: number; reason: string }
  | { unrouted: true; reason: string }

interface AttentionRoutingRule {
  role: AttentionRoleKey
  /** May contain `{name}`, filled in with the resolved operator's display
   *  name (falling back to the role key if the roster has no name on file) —
   *  e.g. "Payroll — {name} handles crew" becomes "Payroll — Jay handles crew". */
  reason: string
  /** Explicit escalation, not a conditional buried inside `routeAttention`:
   *  when the item's priority is one of these, the item routes to
   *  `role`/`reason` here instead of the rule's own. */
  escalate?: {
    priorities: AttentionPriority[]
    role: AttentionRoleKey
    reason: string
  }
}

/**
 * Domain -> role, in ONE table so the mapping is reviewable and overridable
 * in one place.
 *
 * Keyed by `subjectType`, or `subjectType:entityType` for `construction_change`
 * items, whose role depends on which kind of entity changed.
 */
export const ATTENTION_ROUTING_TABLE: Record<string, AttentionRoutingRule> = {
  // Chasing and logging an outstanding invoice is office work. But when the
  // item is `critical` — money genuinely at risk — that is a call only the
  // owner makes, so it escalates explicitly rather than as a side effect of
  // some other conditional.
  receivable: {
    role: 'office',
    reason: 'Receivable — {name} chases and logs it.',
    escalate: {
      priorities: ['critical'],
      role: 'owner',
      reason: 'Receivable at critical priority — money at risk is {name}’s call.',
    },
  },

  'construction_change:estimate': {
    role: 'estimator',
    reason: 'Estimate — {name} owns pricing.',
  },

  'construction_change:pay_period': {
    role: 'hr',
    reason: 'Payroll — {name} handles crew.',
  },

  // Purchase orders are office paperwork normally, but a `decision` or
  // `critical` priority purchase order is a vendor/money call — the owner's,
  // not the office's.
  'construction_change:purchase_order': {
    role: 'office',
    reason: 'Purchase order — {name} tracks the vendor paperwork.',
    escalate: {
      priorities: ['decision', 'critical'],
      role: 'owner',
      reason: 'Purchase order flagged decision/critical — vendors and money are {name}’s call.',
    },
  },

  'construction_change:project': {
    role: 'office',
    reason: 'Project update — {name} keeps the paper trail current.',
  },

  'construction_change:receipt': {
    role: 'office',
    reason: 'Receipt — {name} files it.',
  },

  // Document filing, and it is office work by role — the audit found the
  // owner doing this fifteen times a month, and that misallocation is
  // precisely what this table fixes.
  freight_request: {
    role: 'office',
    reason: 'Freight document request — {name} files it.',
  },
}

/** The table key for an item, or `undefined` if nothing in the table applies. */
function routingKeyFor(item: RoutableAttentionItem): string | undefined {
  if (item.entityType) {
    const compound = `${item.subjectType}:${item.entityType}`
    if (compound in ATTENTION_ROUTING_TABLE) return compound
  }
  if (item.subjectType in ATTENTION_ROUTING_TABLE) return item.subjectType
  return undefined
}

/**
 * Shipped defaults for role -> operator id: deliberately empty. See the
 * module doc — a generic kernel has nothing safe to guess about who holds a
 * role at a specific business, so every role starts unmapped (`source:
 * 'default'`, value `null`) until a workspace says otherwise
 * (`source: 'workspace'`). That absence is exactly what makes "a missing role
 * mapping returns unrouted" the correct behavior rather than a bug.
 */
const DEFAULT_ROLE_OPERATORS: Partial<Record<AttentionRoleKey, number>> = {}

export interface RoleOperatorResolution {
  value: number | null
  source: 'workspace' | 'default'
}

/**
 * Role key -> operator id, from `domain_source_connections.config.operator_roles`
 * — the same config object `operator_profiles`/`operator_workers` live on
 * (see `lib/domain-adapters/bedrock/runtime.ts`'s `bedrockIdentityFor`) and
 * the same shipped-default/workspace-override shape `lib/domain-policy.ts`
 * uses everywhere else. A workspace entry always wins over the (empty)
 * shipped default.
 */
export function resolveRoleOperatorId(
  config: Record<string, unknown> | null | undefined,
  role: AttentionRoleKey
): RoleOperatorResolution {
  const roles = (config ?? {})['operator_roles']
  const raw = roles && typeof roles === 'object' ? (roles as Record<string, unknown>)[role] : undefined

  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, source: 'workspace' }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return { value: Number(raw.trim()), source: 'workspace' }
  }

  const fallback = DEFAULT_ROLE_OPERATORS[role]
  return { value: fallback ?? null, source: 'default' }
}

function fillReason(template: string, operator: RoutableOperator | null, role: AttentionRoleKey): string {
  const name = operator?.name?.trim() || role
  return template.replace('{name}', name)
}

/**
 * Route one attention item to the operator who owns it, or say plainly that
 * nobody does yet.
 *
 * Every path that does not return an operator id names, in `reason`, exactly
 * what is missing: no rule for the item, no workspace mapping for the role,
 * the mapped operator isn't on the roster, or the mapped operator is
 * unverified. Never falls back to a different operator — a payroll alert
 * reaching the wrong person is worse than one nobody gets — and never
 * silently defaults to the owner for an item this table has no opinion about.
 */
export function routeAttention(
  item: RoutableAttentionItem,
  roster: RoutableOperator[],
  config?: Record<string, unknown> | null
): RouteResult {
  const key = routingKeyFor(item)
  const rule = key ? ATTENTION_ROUTING_TABLE[key] : undefined
  if (!rule) {
    const described = item.entityType ? `${item.subjectType}:${item.entityType}` : item.subjectType
    return { unrouted: true, reason: `No routing rule for subject type '${described}'.` }
  }

  const escalate = rule.escalate && item.priority && rule.escalate.priorities.includes(item.priority)
  const role = escalate ? rule.escalate!.role : rule.role
  const reasonTemplate = escalate ? rule.escalate!.reason : rule.reason

  const resolution = resolveRoleOperatorId(config, role)
  if (resolution.value == null) {
    return {
      unrouted: true,
      reason: `No operator is mapped to role '${role}' (${fillReason(reasonTemplate, null, role)}) — configure operator_roles.${role} for this workspace.`,
    }
  }

  const operator = roster.find((o) => o.id === resolution.value)
  if (!operator) {
    return {
      unrouted: true,
      reason: `Operator ${resolution.value} is mapped to role '${role}' but is not on the operator roster.`,
    }
  }

  if (!operator.verified) {
    const name = operator.name?.trim() || `operator ${operator.id}`
    return {
      unrouted: true,
      reason: `${name} is mapped to role '${role}' but is not verified — an unverified operator never receives attention.`,
    }
  }

  return { operatorId: operator.id, reason: fillReason(reasonTemplate, operator, role) }
}
