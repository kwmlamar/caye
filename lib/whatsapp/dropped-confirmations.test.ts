import { describe, it, expect } from 'vitest'
import {
  selectDroppedConfirmations,
  formatDroppedConfirmation,
  recipientFromSummary,
  supersedeKey,
  type PendingActionRow,
} from './dropped-confirmations'

const NASSAU = 'America/Nassau'

const KENNETH = 'conv-kenneth'
const VALENCIA = 'conv-valencia'
const CHRISTINA = 'conv-christina'

/** Staged at `staged` (Nassau local on 2026-08-11), TTL 15 minutes. */
function row(over: {
  id: string
  staged: string
  conversation: string
  executed?: string | null
  cancelled?: string | null
  reported?: string | null
  tool?: string
  summary?: string | null
  operator?: number | null
}): PendingActionRow {
  const created = new Date(`2026-08-11T${over.staged}:00-04:00`)
  return {
    id: over.id,
    operator_id: over.operator === undefined ? 1 : over.operator,
    tool_name: over.tool ?? 'send_reply',
    args: { conversation_id: over.conversation },
    summary: over.summary ?? 'Send to Someone (email):\n\nDear Someone,',
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + 15 * 60 * 1000).toISOString(),
    executed_at: over.executed ?? null,
    cancelled_at: over.cancelled ?? null,
    dropped_reported_at: over.reported ?? null,
  }
}

const at = (hhmm: string) => new Date(`2026-08-11T${hhmm}:00-04:00`)

// ── The real afternoon ────────────────────────────────────────────────────
//
// Every row below is a real caye_pending_actions row from Mrs. Max's session
// on 2026-08-11. Five of the ten expired unexecuted; exactly one of those was
// a genuine dropped send. The rest were drafts she revised.
const REAL_AFTERNOON: PendingActionRow[] = [
  // Kenneth: staged, revised, revised again — the third one went out.
  row({ id: 'k1', staged: '14:49', conversation: KENNETH, summary: 'Send to Kenneth Cal (email):\n\nDear Kenneth,' }),
  row({ id: 'k2', staged: '14:51', conversation: KENNETH, summary: 'Send to Kenneth Cal (email):\n\nDear Kenneth,' }),
  row({ id: 'k3', staged: '14:53', conversation: KENNETH, executed: '2026-08-11T18:53:59Z', summary: 'Send to Kenneth Cal (email):\n\nDear Kenneth,' }),

  // Valencia: staged at 14:57, she answered "yes" at 14:58, nothing happened.
  row({ id: 'v1', staged: '14:57', conversation: VALENCIA, summary: 'Send to Valencia Wills (email):\n\nDear Valencia,' }),

  // Christina: two revisions, then the one that went out.
  row({ id: 'c1', staged: '16:21', conversation: CHRISTINA, summary: 'Send to Christina Masters (email):\n\nDear Christina,' }),
  row({ id: 'c2', staged: '16:23', conversation: CHRISTINA, summary: 'Send to Christina Masters (email):\n\nDear Christina,' }),
  row({ id: 'c3', staged: '16:25', conversation: CHRISTINA, executed: '2026-08-11T20:26:00Z', summary: 'Send to Christina Masters (email):\n\nDear Christina,' }),
]

describe('the 2026-08-11 afternoon', () => {
  it('catches Valencia, and only Valencia, once her row expires', () => {
    // 15:20 — Valencia's row expired at 15:12. Kenneth's and Christina's
    // revisions are superseded by the sends that actually went out.
    const dropped = selectDroppedConfirmations({ rows: REAL_AFTERNOON, now: at('15:20') })
    expect(dropped.map((d) => d.id)).toEqual(['v1'])
  })

  it('would have reached her 24 minutes after the drop, not 51', () => {
    // Expiry 15:12 + 2min grace. She only found out at 15:44 by accident.
    const dropped = selectDroppedConfirmations({ rows: REAL_AFTERNOON, now: at('15:15') })
    expect(dropped.map((d) => d.id)).toEqual(['v1'])
  })

  it('stays silent while her row is still live', () => {
    // 15:05 — staged but not yet expired. She may still be typing.
    expect(selectDroppedConfirmations({ rows: REAL_AFTERNOON, now: at('15:05') })).toEqual([])
  })

  it('stays silent inside the grace period', () => {
    // 15:13 — one minute past expiry. A confirm could be in flight.
    expect(selectDroppedConfirmations({ rows: REAL_AFTERNOON, now: at('15:13') })).toEqual([])
  })

  it('never mentions the four revised drafts', () => {
    const dropped = selectDroppedConfirmations({ rows: REAL_AFTERNOON, now: at('18:00') })
    const ids = dropped.map((d) => d.id)
    expect(ids).not.toContain('k1')
    expect(ids).not.toContain('k2')
    expect(ids).not.toContain('c1')
    expect(ids).not.toContain('c2')
  })

  it('goes quiet once the send is restaged later', () => {
    // At 15:44 Caye restaged Valencia and it went out at 15:49. After that,
    // the dead 14:57 row is history and must not produce a ping.
    const withRestage = [
      ...REAL_AFTERNOON,
      row({ id: 'v2', staged: '15:44', conversation: VALENCIA, executed: '2026-08-11T19:49:00Z' }),
    ]
    expect(selectDroppedConfirmations({ rows: withRestage, now: at('16:30') })).toEqual([])
  })
})

describe('selectDroppedConfirmations', () => {
  it('ignores executed and cancelled rows', () => {
    const rows = [
      row({ id: 'a', staged: '10:00', conversation: 'c-a', executed: '2026-08-11T14:05:00Z' }),
      row({ id: 'b', staged: '10:00', conversation: 'c-b', cancelled: '2026-08-11T14:05:00Z' }),
    ]
    expect(selectDroppedConfirmations({ rows, now: at('12:00') })).toEqual([])
  })

  it('reports each operator only once', () => {
    const rows = [row({ id: 'a', staged: '10:00', conversation: 'c-a', reported: '2026-08-11T14:30:00Z' })]
    expect(selectDroppedConfirmations({ rows, now: at('12:00') })).toEqual([])
  })

  it('does not dig up rows older than the window', () => {
    const old = row({ id: 'old', staged: '10:00', conversation: 'c-old' })
    old.created_at = '2026-08-01T14:00:00Z'
    old.expires_at = '2026-08-01T14:15:00Z'
    expect(selectDroppedConfirmations({ rows: [old], now: at('12:00') })).toEqual([])
  })

  // Two operators share the back-office channel. One's revision must not
  // silence the other's dropped send.
  it('does not let one operator supersede another', () => {
    const rows = [
      row({ id: 'mrs-max', staged: '14:00', conversation: VALENCIA, operator: 1 }),
      row({ id: 'max', staged: '14:10', conversation: VALENCIA, operator: 22 }),
    ]
    const dropped = selectDroppedConfirmations({ rows, now: at('15:00') })
    expect(dropped.map((d) => d.id).sort()).toEqual(['max', 'mrs-max'])
  })

  // A revised draft for a DIFFERENT customer is not a supersede.
  it('does not let one customer supersede another', () => {
    const rows = [
      row({ id: 'valencia', staged: '14:00', conversation: VALENCIA }),
      row({ id: 'kenneth', staged: '14:10', conversation: KENNETH, executed: '2026-08-11T18:11:00Z' }),
    ]
    expect(selectDroppedConfirmations({ rows, now: at('15:00') }).map((d) => d.id)).toEqual(['valencia'])
  })

  it('survives rows with no args at all', () => {
    const bare = row({ id: 'bare', staged: '14:00', conversation: 'x' })
    bare.args = null
    expect(selectDroppedConfirmations({ rows: [bare], now: at('15:00') }).map((d) => d.id)).toEqual(['bare'])
  })
})

describe('supersedeKey', () => {
  it('keys on the thread, so an edited draft supersedes its predecessor', () => {
    const a = row({ id: 'a', staged: '14:00', conversation: VALENCIA })
    const b = row({ id: 'b', staged: '14:05', conversation: VALENCIA })
    b.summary = 'Send to Valencia Wills (email):\n\nCompletely different text'
    expect(supersedeKey(a)).toBe(supersedeKey(b))
  })

  it('falls back to the tool name when there is no conversation', () => {
    const r = row({ id: 'a', staged: '14:00', conversation: 'x', tool: 'send_outreach_batch' })
    r.args = {}
    expect(supersedeKey(r)).toBe('send_outreach_batch')
  })
})

describe('recipientFromSummary', () => {
  it('reads the name out of a staged send', () => {
    expect(recipientFromSummary('Send to Valencia Wills (email):\n\nDear Valencia,')).toBe('Valencia Wills')
  })

  it('returns null rather than guessing', () => {
    expect(recipientFromSummary(null)).toBeNull()
    expect(recipientFromSummary('Something else entirely')).toBeNull()
  })
})

describe('formatDroppedConfirmation', () => {
  const dropped = {
    id: 'v1',
    operatorId: 1,
    toolName: 'send_reply',
    summary: 'Send to Valencia Wills (email):\n\nDear Valencia,',
    stagedAt: new Date('2026-08-11T18:57:57Z'),
  }

  it('names the customer and the local time it was staged', () => {
    const msg = formatDroppedConfirmation(dropped, NASSAU)
    expect(msg).toContain('Valencia Wills')
    expect(msg).toContain('2:57')
    expect(msg).toContain('PM')
  })

  // We do not know whether her confirmation reached us. Asserting that she
  // approved it would be a fresh lie on top of the dropped send.
  it('does not claim the operator approved it', () => {
    const msg = formatDroppedConfirmation(dropped, NASSAU)
    expect(msg).not.toMatch(/you (said|told me) yes/i)
    expect(msg).not.toMatch(/you approved/i)
    expect(msg).toMatch(/if you told me to send it/i)
  })

  it('says plainly that it did not go out, and offers the redo', () => {
    const msg = formatDroppedConfirmation(dropped, NASSAU)
    expect(msg).toMatch(/never went out/i)
    expect(msg).toMatch(/set it back up/i)
  })

  it('degrades gracefully when the recipient is unknown', () => {
    const msg = formatDroppedConfirmation({ ...dropped, summary: null }, NASSAU)
    expect(msg).toContain('a reply')
    expect(msg).not.toContain('undefined')
    expect(msg).not.toContain('null')
  })
})
