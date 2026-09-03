import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { selectToolSurface } from './execute'
import type { ToolContext } from './tools/types'

const contextFor = (callerRole: ToolContext['callerRole']): ToolContext => ({
  workspaceId: 'ws_test',
  callerRole,
  requestId: `req_${callerRole}`,
})

describe('production tool surface', () => {
  it('reports deterministic role-specific production counts', () => {
    const owner = selectToolSurface({ ctx: contextFor('owner'), mode: 'back-office' }).metrics
    const founder = selectToolSurface({ ctx: contextFor('founder'), mode: 'back-office' }).metrics
    const staff = selectToolSurface({ ctx: contextFor('staff'), mode: 'back-office' }).metrics
    // The numbers make the concrete optimization reviewable: owners lose
    // founder-only schemas; staff see only schemas they could execute.
    //
    // These are a DRIFT DETECTOR, not a target. They had gone stale on main
    // well before CAY-194 (owner excludedByRoleCount was asserted as 4 while
    // the real value was already 29, and founder exposedToolCount as 77
    // against a real 99), so the test had stopped failing informatively and
    // started failing constantly. Refreshed here to the true post-CAY-194
    // values. If a change moves these, update them deliberately and say why
    // in the PR — do not "fix" the test by loosening the assertion.
    //
    // Refreshed again 2026-09-03 (repository audit dispatch): the tool
    // registry grew further since the CAY-194 snapshot above — dozens of
    // commits have touched lib/caye-agent/tools/** since (new tools,
    // schema changes) — so these three counts had drifted stale again with
    // no change of their own. Updated to the true current values measured
    // against this branch; still an exact, unweakened toMatchObject
    // assertion.
    expect(owner).toMatchObject({ exposedToolCount: 76, excludedByRoleCount: 53, excludedToolSchemaBytes: 34528 })
    expect(founder).toMatchObject({ exposedToolCount: 129, excludedByRoleCount: 0, excludedToolSchemaBytes: 0 })
    expect(staff).toMatchObject({ exposedToolCount: 16, excludedByRoleCount: 113, excludedToolSchemaBytes: 104897 })
  })

  it.each(['owner', 'staff', 'founder', 'driver'] as const)('only exposes schemas executable by %s', (callerRole) => {
    const { tools } = selectToolSurface({ ctx: contextFor(callerRole), mode: 'back-office' })
    expect(tools.every((tool) => tool.roles.includes(callerRole))).toBe(true)
  })

  it('retains the owner authority and confirmation surface', () => {
    const names = selectToolSurface({ ctx: contextFor('owner'), mode: 'back-office' }).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'get_held_queue',
      'get_customer',
      'send_reply',
      'confirm_pending_action',
      'create_customer_booking',
      'send_payment_link',
    ]))
  })
})
