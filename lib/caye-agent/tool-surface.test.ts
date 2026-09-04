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
    // registry grew by 11 since the last refresh — the construction-ledger
    // (Bedrock/TropiTrack) tools registered in lib/caye-agent/tools/registry.ts
    // and high-risk-registry.ts (findJob, getJob, getJobLabor, previewCrewDay,
    // getPayrollStatus, getPayrollOwed, getReceivables, setConstructionPolicy,
    // logCrewDay, logInvoiceSent, recordPayment). Unlike CAY-194's founder-only
    // batch, most of these ARE owner- and several are staff-visible (roles:
    // ['owner','staff','founder'] for the job/crew-day tools, ['owner','founder']
    // for payroll/receivables/invoicing/policy), so exposedToolCount moves for
    // every role this time — owner and founder each gain all 11, staff gains
    // only the 5 job/crew-day tools it has roles for. Owner's own
    // excludedByRoleCount/excludedToolSchemaBytes are unchanged because none
    // of the 11 new tools are founder-only (nothing new becomes invisible to
    // an owner). Still an exact, unweakened toMatchObject assertion.
    // Refreshed again 2026-09-03, later the same day: staff's
    // excludedToolSchemaBytes only, 114255 -> 114516. No tool was added or
    // removed — every other number here is unchanged, including all three
    // exposedToolCounts and both excludedByRoleCounts.
    //
    // Cause, accounted for exactly rather than re-baselined: #467 added one
    // sentence to get_receivables' tool `description` (the "If
    // `nothing_recorded` is true, NOTHING HAS BEEN ENTERED..." instruction
    // that stops an empty register being reported as nothing owed). That
    // string is 261 bytes and the drift is 261 bytes.
    //
    // Only staff moves because get_receivables is roles ['owner','founder']
    // (get-receivables.ts:67): it is excluded from staff, so staff's excluded
    // total grows, and it is visible to an owner, so owner's excluded total
    // does not. That asymmetry is the detector working — it is what makes
    // the number diagnostic instead of just noisy.
    // Refreshed 2026-09-03 for log_receipt: every exposedToolCount +1
    // (owner 87->88, founder 140->141, staff 21->22) and NOTHING else moves.
    // The tool is roles ['owner','staff','founder'], so it is visible to all
    // three and becomes invisible to none — which is exactly why both
    // excludedByRoleCounts and both excludedToolSchemaBytes are unchanged.
    // A new tool that moved an excluded number would mean it was hidden from
    // somebody, and would be worth a second look.
    //
    // Refreshed again 2026-09-04 for the three freight tools, and here an
    // excluded number DOES move — deliberately, unlike log_receipt above.
    // get_freight_workflows (read) and prepare_freight_document (write-low)
    // are roles ['owner','staff','founder']; send_freight_document is
    // roles ['owner','founder'], because actually emailing a forwarder an
    // attachment built from this workspace's purchase evidence is an owner
    // decision. So:
    //   owner   88->91  (+3, all three visible), excluded 53 unchanged
    //   founder 141->144 (+3, sees everything), still 0/0
    //   staff   22->24  (+2 only), excludedByRoleCount 119->120 and
    //                   excludedToolSchemaBytes 114516->115784
    // That single +1 on staff's excluded count IS send_freight_document being
    // hidden from staff. It is the intended authority boundary, not drift.
    expect(owner).toMatchObject({ exposedToolCount: 91, excludedByRoleCount: 53, excludedToolSchemaBytes: 34528 })
    expect(founder).toMatchObject({ exposedToolCount: 144, excludedByRoleCount: 0, excludedToolSchemaBytes: 0 })
    expect(staff).toMatchObject({ exposedToolCount: 24, excludedByRoleCount: 120, excludedToolSchemaBytes: 115784 })
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
