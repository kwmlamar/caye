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
    expect(owner).toMatchObject({ exposedToolCount: 73, excludedByRoleCount: 4, excludedToolSchemaBytes: 3586 })
    expect(founder).toMatchObject({ exposedToolCount: 77, excludedByRoleCount: 0, excludedToolSchemaBytes: 0 })
    expect(staff).toMatchObject({ exposedToolCount: 13, excludedByRoleCount: 64, excludedToolSchemaBytes: 73576 })
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
