/**
 * Pure target-selection logic for autonomous lead sourcing. Deliberately
 * has no Supabase/network dependency so the rotation itself — and the
 * question "does this rotation actually reach enough active targets to
 * keep a 50/day send buffer full?" — can be exercised deterministically in
 * tests, without a live database or the Places API.
 *
 * Extracted 2026-08-19 (CAY-98): the previous inline query ordered targets
 * by `priority` first and `last_sourced_at` second. Every seeded target has
 * a distinct priority (10, 15, 20 … 55), so the first sort key alone fully
 * determined the result — the freshness tiebreak never ran, and the
 * lowest-priority target (Nassau tour operators) was selected forever while
 * active. 9 of 10 active targets had never been sourced as a result.
 */

export interface SourcingTarget {
  id: string
  vertical: string
  region: string
  priority: number
  last_sourced_at: string | null
}

/**
 * Orders active targets so every one of them eventually gets a turn.
 * Freshness (never-sourced, then longest-idle) is the primary key so a
 * target cannot be starved forever by a lower priority number; priority is
 * only a tiebreak among targets that are equally fresh (typically several
 * `last_sourced_at: null` targets on day one).
 */
export function rankSourcingTargets(targets: readonly SourcingTarget[]): SourcingTarget[] {
  return targets
    .slice()
    .sort((a, b) => {
      const aTime = a.last_sourced_at ? Date.parse(a.last_sourced_at) : -Infinity
      const bTime = b.last_sourced_at ? Date.parse(b.last_sourced_at) : -Infinity
      if (aTime !== bTime) return aTime - bTime
      return a.priority - b.priority
    })
}

/**
 * Targets a single sourcing run should attempt, in rotation order. Stops
 * short of the full ranked list only via `maxTargetsPerRun` — the live job
 * additionally re-checks the real unsent-supply count between attempts and
 * stops early once the buffer covers the daily cap, which this pure
 * function can't see (that requires a DB read after each insert).
 */
export function selectSourcingTargetsForRun(args: {
  targets: readonly SourcingTarget[]
  startingUnsentSupply: number
  dailyCap: number
  maxTargetsPerRun: number
}): SourcingTarget[] {
  if (args.startingUnsentSupply >= args.dailyCap) return []
  return rankSourcingTargets(args.targets).slice(0, args.maxTargetsPerRun)
}

export interface SimulatedRotationDay {
  day: number
  targetsSourced: string[]
  suppliedAdded: number
  /** Buffer right after sourcing, before that day's sends are subtracted. */
  unsentSupplyPeak: number
  /** Buffer at the end of the day, after `sentPerDay` sends. */
  unsentSupplyEnd: number
}

/**
 * Deterministic dry-run planner: simulates repeated daily sourcing runs
 * against a fixed target list and a per-target yield assumption, tracking
 * the unsent buffer and which targets get visited over time. Used to
 * demonstrate — without hitting Places or a database — that the fixed
 * rotation reaches every active target and can sustain a buffer covering
 * `dailyCap` under a plausible per-target net-new-lead yield.
 */
export function simulateDailySourcingRotation(args: {
  targets: readonly SourcingTarget[]
  /** Net new qualified, deduped leads a single batch against a target adds. Keyed by target id. */
  yieldByTargetId: Record<string, number>
  dailyCap: number
  maxTargetsPerRun: number
  sentPerDay: number
  days: number
  startingUnsentSupply?: number
}): SimulatedRotationDay[] {
  let unsentSupply = args.startingUnsentSupply ?? 0
  const lastSourcedAt = new Map<string, string | null>(args.targets.map((t) => [t.id, t.last_sourced_at]))
  const results: SimulatedRotationDay[] = []

  for (let day = 1; day <= args.days; day++) {
    const state = args.targets.map((t) => ({ ...t, last_sourced_at: lastSourcedAt.get(t.id) ?? null }))
    const targetsSourced: string[] = []
    let suppliedAdded = 0
    let remainingAttempts = args.maxTargetsPerRun

    for (const target of rankSourcingTargets(state)) {
      if (remainingAttempts <= 0) break
      if (unsentSupply >= args.dailyCap) break
      const added = args.yieldByTargetId[target.id] ?? 0
      unsentSupply += added
      suppliedAdded += added
      targetsSourced.push(target.id)
      lastSourcedAt.set(target.id, `day-${day}`)
      remainingAttempts--
    }

    const unsentSupplyPeak = unsentSupply
    unsentSupply = Math.max(0, unsentSupply - args.sentPerDay)
    results.push({ day, targetsSourced, suppliedAdded, unsentSupplyPeak, unsentSupplyEnd: unsentSupply })
  }

  return results
}
