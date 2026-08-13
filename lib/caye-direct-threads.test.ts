import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Minimal in-memory fake of the Supabase query builder, purpose-built for
 * the exact call shapes lib/caye-direct-threads.ts uses — not a general
 * Supabase mock. Supports insert/update/upsert/select with .eq/.in/.order/
 * .limit/.single/.maybeSingle, plus the one embedded-join select
 * (`caye_direct_thread_entities!inner`... actually `caye_direct_threads!inner`)
 * getOrCreateDirectThread relies on to find an existing thread for a
 * subject, resolved here by hand-joining in JS rather than trying to
 * emulate PostgREST's embed syntax generically.
 */
type Row = Record<string, unknown>

function makeFakeSupabase(db: Record<string, Row[]>) {
  let nextId = 1
  function genId(table: string) {
    if (table === 'caye_direct_thread_entities') return nextId++
    return `${table}-${nextId++}`
  }

  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let payload: Row | Row[] | null = null
    let selectCols = '*'
    const filters: Array<{ col: string; val: unknown; kind: 'eq' | 'in' }> = []
    let limitN: number | undefined
    let orderCol: string | undefined
    let orderAsc = true

    const builder: any = {
      select(cols: string) { selectCols = cols; return builder },
      insert(p: Row) { op = 'insert'; payload = p; return builder },
      update(p: Row) { op = 'update'; payload = p; return builder },
      upsert(p: Row, _opts?: unknown) { op = 'upsert'; payload = p; return builder },
      eq(col: string, val: unknown) { filters.push({ col, val, kind: 'eq' }); return builder },
      in(col: string, val: unknown[]) { filters.push({ col, val, kind: 'in' }); return builder },
      or() { return builder },
      order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder },
      limit(n: number) { limitN = n; return builder },
      single() { return execSingle(true) },
      maybeSingle() { return execSingle(false) },
      then(resolve: (v: unknown) => unknown) { return exec().then(resolve) },
    }

    function matchesDirect(row: Row): boolean {
      return filters
        .filter((f) => !f.col.includes('.'))
        .every((f) => (f.kind === 'in' ? (f.val as unknown[]).includes(row[f.col]) : row[f.col] === f.val))
    }

    function withDefaults(r: Row): Row {
      const row: Row = { id: genId(table), created_at: new Date().toISOString(), ...r }
      // Mirror the migration's column defaults — the fake has no schema to
      // read them from, so a row missing `status` here would silently fail
      // every downstream .eq('status', 'active') filter.
      if (table === 'caye_direct_threads') {
        row.status = row.status ?? 'active'
        row.last_activity_at = row.last_activity_at ?? row.created_at
      }
      return row
    }

    async function execSingle(required: boolean) {
      if (op === 'insert' || op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload as Row]
        const inserted = rows.map((r) => {
          const row = withDefaults(r)
          db[table] = db[table] ?? []
          db[table].push(row)
          return row
        })
        return { data: inserted[0] ?? null, error: null }
      }
      const result = await exec()
      const row = (result.data as Row[])[0] ?? null
      if (!row && required) return { data: null, error: { message: 'not found' } }
      return { data: row, error: null }
    }

    async function exec() {
      db[table] = db[table] ?? []
      if (op === 'insert' || op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload as Row]
        const inserted = rows.map((r) => withDefaults(r))
        db[table].push(...inserted)
        return { data: inserted, error: null }
      }
      if (op === 'update') {
        const matched = db[table].filter(matchesDirect)
        matched.forEach((row) => Object.assign(row, payload))
        return { data: matched, error: null }
      }
      // select — special-case the one embedded-join query getOrCreateDirectThread issues.
      if (selectCols.includes('caye_direct_threads!inner')) {
        const joinFilters = filters.filter((f) => f.col.startsWith('caye_direct_threads.'))
        const base = db[table].filter(matchesDirect)
        type Joined = { thread_id: unknown; caye_direct_threads: Row }
        const joined = base
          .map((row): Joined | null => {
            const thread = (db['caye_direct_threads'] ?? []).find((t) => t.id === row.thread_id)
            return thread ? { thread_id: row.thread_id, caye_direct_threads: thread } : null
          })
          .filter((r): r is Joined => !!r)
          .filter((r) =>
            joinFilters.every((f) => r.caye_direct_threads[f.col.split('.')[1]] === f.val)
          )
        return { data: limitN ? joined.slice(0, limitN) : joined, error: null }
      }
      let rows = db[table].filter(matchesDirect)
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[orderCol!]), bv = String(b[orderCol!])
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      if (limitN) rows = rows.slice(0, limitN)
      return { data: rows, error: null }
    }

    return builder
  }

  return { from }
}

let DB: Record<string, Row[]>
let FOUNDER_OPERATOR: { id: number; name: string | null; role: 'founder' } | null

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => makeFakeSupabase(DB),
}))
vi.mock('@/lib/operator-identity', () => ({
  resolveFounderOperator: () => Promise.resolve(FOUNDER_OPERATOR),
}))

import {
  createThread,
  getOrCreateDirectThread,
  linkMessageToThread,
  linkInsertedMessagesToThreads,
  listThreads,
  getThread,
  getThreadMessages,
  createCayeInitiatedThreadMessage,
  setThreadStatus,
} from './caye-direct-threads'
import { createServiceClient } from '@/lib/supabase-server'

const WS_A = 'workspace-a'
const WS_B = 'workspace-b'

beforeEach(() => {
  DB = { caye_direct_threads: [], caye_direct_thread_entities: [], caye_direct_thread_messages: [], caye_operator_messages: [] }
  FOUNDER_OPERATOR = { id: 1, name: 'Lamar', role: 'founder' }
})

describe('archived threads stay readable and resumable', () => {
  it('remains readable by id after archiving, and reactivates when un-archived', async () => {
    const supabase = createServiceClient()
    const thread = await createThread(supabase, { workspaceId: WS_A, createdBy: 'founder', title: 'Deposit policy' })

    await setThreadStatus(supabase, WS_A, thread.id, 'archived')

    // getThread has no status filter — this is exactly what the GET
    // detail route relies on to keep an archived thread inspectable.
    const readBack = await getThread(supabase, WS_A, thread.id)
    expect(readBack?.status).toBe('archived')
    expect(readBack?.title).toBe('Deposit policy')

    // The dropped-out-of-the-default-list state is not reused when a new
    // message lands — the POST route reactivates it (mirrors that call).
    await setThreadStatus(supabase, WS_A, thread.id, 'active')
    const active = await listThreads(supabase, WS_A, { status: 'active' })
    expect(active.map((t) => t.id)).toContain(thread.id)
  })

  it('archiving never deletes the underlying messages', async () => {
    const supabase = createServiceClient()
    const thread = await createThread(supabase, { workspaceId: WS_A, createdBy: 'founder', title: 'Outreach performance' })
    const { data: m } = await supabase.from('caye_operator_messages').insert({
      workspace_id: WS_A, direction: 'inbound', body: 'how is outreach doing', origin: 'dashboard',
    }).select('id').single()
    await linkMessageToThread(supabase, thread.id, m!.id, 'founder')

    await setThreadStatus(supabase, WS_A, thread.id, 'archived')

    expect(DB.caye_operator_messages).toHaveLength(1)
    const messages = await getThreadMessages(supabase, thread.id)
    expect(messages).toHaveLength(1)
  })
})

describe('getOrCreateDirectThread', () => {
  it('creates a new thread on first mention of a subject (Test G, part 1)', async () => {
    const supabase = createServiceClient()
    const { thread, reused } = await getOrCreateDirectThread(supabase, {
      workspaceId: WS_A,
      subjectType: 'escalation',
      subjectId: 'esc-1',
      titleHint: 'Emily pricing exception',
      createdBy: 'caye',
    })
    expect(reused).toBe(false)
    expect(thread.title).toBe('Emily pricing exception')
    expect(DB.caye_direct_threads).toHaveLength(1)
    expect(DB.caye_direct_thread_entities).toHaveLength(1)
  })

  it('reuses the existing open thread on a second mention of the same subject (Test G, part 2)', async () => {
    const supabase = createServiceClient()
    const first = await getOrCreateDirectThread(supabase, {
      workspaceId: WS_A,
      subjectType: 'escalation',
      subjectId: 'esc-1',
      titleHint: 'Emily pricing exception',
      createdBy: 'caye',
    })
    const second = await getOrCreateDirectThread(supabase, {
      workspaceId: WS_A,
      subjectType: 'escalation',
      subjectId: 'esc-1',
      titleHint: 'Emily update',
      createdBy: 'caye',
    })
    expect(second.reused).toBe(true)
    expect(second.thread.id).toBe(first.thread.id)
    // No duplicate thread spawned — "Emily update 2" never happens.
    expect(DB.caye_direct_threads).toHaveLength(1)
  })

  it('does not reuse a thread across workspaces even with the same subject id (Test H)', async () => {
    const supabase = createServiceClient()
    const a = await getOrCreateDirectThread(supabase, {
      workspaceId: WS_A, subjectType: 'escalation', subjectId: 'esc-1', titleHint: 'A', createdBy: 'caye',
    })
    const b = await getOrCreateDirectThread(supabase, {
      workspaceId: WS_B, subjectType: 'escalation', subjectId: 'esc-1', titleHint: 'B', createdBy: 'caye',
    })
    expect(b.reused).toBe(false)
    expect(b.thread.id).not.toBe(a.thread.id)
  })
})

describe('listThreads — workspace isolation (Test H)', () => {
  it('never returns another workspace\'s threads', async () => {
    const supabase = createServiceClient()
    await createThread(supabase, { workspaceId: WS_A, createdBy: 'founder', title: 'Bimini thread' })
    await createThread(supabase, { workspaceId: WS_B, createdBy: 'founder', title: 'Outreach thread' })

    const listA = await listThreads(supabase, WS_A)
    const listB = await listThreads(supabase, WS_B)

    expect(listA).toHaveLength(1)
    expect(listA[0].title).toBe('Bimini thread')
    expect(listB).toHaveLength(1)
    expect(listB[0].title).toBe('Outreach thread')
  })
})

describe('thread persistence across "reopen" (Test A) and no midnight split (Test B)', () => {
  it('keeps messages linked to one thread regardless of which calendar day they landed on', async () => {
    const supabase = createServiceClient()
    const thread = await createThread(supabase, { workspaceId: WS_A, createdBy: 'founder', title: 'August bookings' })

    const day1 = new Date('2026-08-13T23:50:00Z').toISOString()
    const day2 = new Date('2026-08-14T00:10:00Z').toISOString()

    const { data: m1 } = await supabase.from('caye_operator_messages').insert({
      workspace_id: WS_A, direction: 'inbound', body: 'hi', created_at: day1, origin: 'dashboard',
    }).select('id').single()
    const { data: m2 } = await supabase.from('caye_operator_messages').insert({
      workspace_id: WS_A, direction: 'outbound', body: 'still here', created_at: day2, origin: 'dashboard',
    }).select('id').single()

    await linkMessageToThread(supabase, thread.id, m1!.id, 'founder')
    await linkMessageToThread(supabase, thread.id, m2!.id, 'caye')

    // "Reopening" is just re-reading — no separate thread was ever created
    // for day2, and no new thread row exists anywhere.
    expect(DB.caye_direct_threads.filter((t) => t.workspace_id === WS_A)).toHaveLength(1)

    const messages = await getThreadMessages(supabase, thread.id)
    expect(messages.map((m) => m.body)).toEqual(['hi', 'still here'])
  })
})

describe('linkInsertedMessagesToThreads — multi-topic message (Test F)', () => {
  it('links one message into every thread relate_to_direct_thread requested, without duplicating the message row', async () => {
    const supabase = createServiceClient()
    const threadEmily = await createThread(supabase, { workspaceId: WS_A, createdBy: 'caye', title: 'Emily pricing exception' })
    const threadRuslan = await createThread(supabase, { workspaceId: WS_A, createdBy: 'caye', title: 'Ruslan follow-up' })

    const { data: msg } = await supabase.from('caye_operator_messages').insert({
      workspace_id: WS_A, direction: 'inbound', body: 'Emily is fine at $275, also stop following up with Ruslan', origin: 'whatsapp',
    }).select('id').single()

    await linkInsertedMessagesToThreads(supabase, [msg!.id], [threadEmily.id, threadRuslan.id])

    // Still exactly one caye_operator_messages row — the canonical event
    // was never duplicated to satisfy two threads.
    expect(DB.caye_operator_messages).toHaveLength(1)
    // But it's linked into both.
    const links = DB.caye_direct_thread_messages.filter((l) => l.message_id === msg!.id)
    expect(links.map((l) => l.thread_id).sort()).toEqual([threadEmily.id, threadRuslan.id].sort())
  })

  it('no-ops instantly when there is nothing to link (the overwhelming majority of WhatsApp turns)', async () => {
    const supabase = createServiceClient()
    await linkInsertedMessagesToThreads(supabase, ['m1'], [])
    await linkInsertedMessagesToThreads(supabase, [], ['t1'])
    expect(DB.caye_direct_thread_messages).toHaveLength(0)
  })
})

describe('createCayeInitiatedThreadMessage (Test G, founder-backstop shape)', () => {
  it('creates a thread attributed to the founder operator, not a business operator', async () => {
    const supabase = createServiceClient()
    const result = await createCayeInitiatedThreadMessage(supabase, {
      workspaceId: WS_A,
      subjectType: 'escalation',
      subjectId: 'esc-9',
      titleHint: 'Jeff — needs your call',
      message: "Looping you in — Jeff has been waiting 7 days.",
    })
    expect(result?.reused).toBe(false)
    const msgRow = DB.caye_operator_messages[0]
    expect(msgRow.operator_role).toBe('founder')
    expect(msgRow.origin).toBe('dashboard')
    expect(msgRow.direction).toBe('outbound')

    const thread = await getThread(supabase, WS_A, result!.thread.id)
    expect(thread?.created_by).toBe('caye')
  })
})
