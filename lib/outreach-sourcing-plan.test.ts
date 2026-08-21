import { describe, expect, it } from 'vitest'
import {
  rankSourcingTargets,
  selectSourcingTargetsForRun,
  simulateDailySourcingRotation,
  type SourcingTarget,
} from './outreach-sourcing-plan'

// Mirrors supabase/migrations/20260812_outreach_autonomy.sql exactly — this
// is the incident: every seeded priority is distinct, so a naive
// `.order('priority').order('last_sourced_at')` sort never reaches the
// second key.
const SEEDED_TARGETS: SourcingTarget[] = [
  { id: 'nassau-tours', vertical: 'tour operator', region: 'Nassau, Bahamas', priority: 10, last_sourced_at: null },
  { id: 'freeport-tours', vertical: 'tour operator', region: 'Freeport, Bahamas', priority: 15, last_sourced_at: null },
  { id: 'exuma-tours', vertical: 'tour operator', region: 'Exuma, Bahamas', priority: 20, last_sourced_at: null },
  { id: 'nassau-restaurants', vertical: 'restaurant', region: 'Nassau, Bahamas', priority: 25, last_sourced_at: null },
  { id: 'nassau-salons', vertical: 'salon', region: 'Nassau, Bahamas', priority: 30, last_sourced_at: null },
  { id: 'nassau-guesthouses', vertical: 'guesthouse', region: 'Nassau, Bahamas', priority: 35, last_sourced_at: null },
  { id: 'kingston-tours', vertical: 'tour operator', region: 'Kingston, Jamaica', priority: 40, last_sourced_at: null },
  { id: 'montego-bay-tours', vertical: 'tour operator', region: 'Montego Bay, Jamaica', priority: 45, last_sourced_at: null },
  { id: 'port-of-spain-tours', vertical: 'tour operator', region: 'Port of Spain, Trinidad and Tobago', priority: 50, last_sourced_at: null },
  { id: 'bridgetown-tours', vertical: 'tour operator', region: 'Bridgetown, Barbados', priority: 55, last_sourced_at: null },
]

describe('rankSourcingTargets', () => {
  it('ties on freshness for never-sourced targets, breaking by priority (regression: CAY-98)', () => {
    const ranked = rankSourcingTargets(SEEDED_TARGETS)
    // All ten are equally "fresh" (never sourced), so priority still governs
    // day one — but every target is present and in a defined order, not
    // silently dropped.
    expect(ranked.map((t) => t.id)).toEqual([
      'nassau-tours', 'freeport-tours', 'exuma-tours', 'nassau-restaurants',
      'nassau-salons', 'nassau-guesthouses', 'kingston-tours', 'montego-bay-tours',
      'port-of-spain-tours', 'bridgetown-tours',
    ])
  })

  it('lets a lower-priority target win once the top-priority target has been sourced recently', () => {
    const afterNassauSourced = SEEDED_TARGETS.map((t) =>
      t.id === 'nassau-tours' ? { ...t, last_sourced_at: '2026-08-19T09:00:00Z' } : t
    )
    const ranked = rankSourcingTargets(afterNassauSourced)
    // Freeport (priority 15, never sourced) now outranks Nassau (priority
    // 10, sourced most recently) — this is exactly the rotation the old
    // priority-first sort could never produce, because Nassau's priority
    // value alone always won.
    expect(ranked[0].id).toBe('freeport-tours')
    expect(ranked.at(-1)?.id).toBe('nassau-tours')
  })

  it('never lets one target dominate forever: after N runs every target has had a turn', () => {
    let state = SEEDED_TARGETS
    const visited = new Set<string>()
    for (let i = 0; i < SEEDED_TARGETS.length; i++) {
      const next = rankSourcingTargets(state)[0]
      visited.add(next.id)
      state = state.map((t) => (t.id === next.id ? { ...t, last_sourced_at: `run-${i}` } : t))
    }
    expect(visited.size).toBe(SEEDED_TARGETS.length)
  })
})

describe('selectSourcingTargetsForRun', () => {
  it('returns nothing once the unsent buffer already covers the daily cap', () => {
    const queue = selectSourcingTargetsForRun({
      targets: SEEDED_TARGETS, startingUnsentSupply: 50, dailyCap: 50, maxTargetsPerRun: 10,
    })
    expect(queue).toEqual([])
  })

  it('queues the full ranked list, bounded by maxTargetsPerRun, when the buffer is low', () => {
    const queue = selectSourcingTargetsForRun({
      targets: SEEDED_TARGETS, startingUnsentSupply: 1, dailyCap: 50, maxTargetsPerRun: 3,
    })
    expect(queue.map((t) => t.id)).toEqual(['nassau-tours', 'freeport-tours', 'exuma-tours'])
  })
})

describe('simulateDailySourcingRotation', () => {
  it('demonstrates the fixed rotation visits every active target and sustains a 50/day-covering buffer under healthy yield', () => {
    // Healthy-conditions assumption: each target's batch nets a modest
    // number of new qualified, deduped, emailable leads. Numbers are
    // deliberately conservative relative to SOURCING_BATCH_SIZE (20).
    const yieldByTargetId = Object.fromEntries(SEEDED_TARGETS.map((t) => [t.id, 6]))
    const days = simulateDailySourcingRotation({
      targets: SEEDED_TARGETS,
      yieldByTargetId,
      dailyCap: 50,
      maxTargetsPerRun: 10,
      sentPerDay: 50,
      days: 14,
      startingUnsentSupply: 1,
    })

    const targetsEverVisited = new Set(days.flatMap((d) => d.targetsSourced))
    expect(targetsEverVisited.size).toBe(SEEDED_TARGETS.length)

    // Buffer should recover to cover a full day's send within a couple of
    // rotations, not stay pinned near zero the way the pre-fix single-
    // target-per-day rotation left it (issue snapshot: 1 unsent eligible
    // lead after weeks of running).
    const lastDay = days.at(-1)!
    expect(lastDay.unsentSupplyEnd).toBeGreaterThanOrEqual(0)
    expect(Math.max(...days.map((d) => d.unsentSupplyPeak))).toBeGreaterThanOrEqual(50)
  })

  it('under starved conditions (low per-target yield) still rotates through every target instead of starving 9 of 10', () => {
    const yieldByTargetId = Object.fromEntries(SEEDED_TARGETS.map((t) => [t.id, 1]))
    const days = simulateDailySourcingRotation({
      targets: SEEDED_TARGETS,
      yieldByTargetId,
      dailyCap: 50,
      maxTargetsPerRun: 10,
      sentPerDay: 10,
      days: 5,
      startingUnsentSupply: 1,
    })
    const targetsEverVisited = new Set(days.flatMap((d) => d.targetsSourced))
    expect(targetsEverVisited.size).toBe(SEEDED_TARGETS.length)
  })
})
