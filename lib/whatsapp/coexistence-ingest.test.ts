import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@/lib/contacts/resolve-contact', () => ({
  resolveOrCreateContact: vi.fn(async () => ({ id: 'contact-1' })),
}))

import { parseWhatsAppWebhook, normalizeEcho } from './coexistence'
import {
  ingestObservedBusinessMessage,
  echoMatchesRecordedCayeSend,
  recordUnattributedBusinessMessage,
} from './coexistence-ingest'

const FIXTURES = path.join(__dirname, 'fixtures', 'coexistence')
const ACCOUNT = { id: 'account-1', workspaceId: 'workspace-1' }
const CUSTOMER_NUMBER = '15550000042'

function observedFrom(fixtureName: string) {
  const payload = JSON.parse(readFileSync(path.join(FIXTURES, `${fixtureName}.json`), 'utf8'))
  const [change] = parseWhatsAppWebhook(payload)
  const observed = normalizeEcho(change.echoes[0], change.metadata!)
  if (!observed) throw new Error(`fixture ${fixtureName} did not normalize`)
  return observed
}

type Row = Record<string, unknown>

interface SingleResult {
  data: Row | null
  error: null
}

interface FakeBuilder {
  select(cols?: string): FakeBuilder
  eq(col: string, val: unknown): FakeBuilder
  contains(col: string, obj: Row): FakeBuilder
  maybeSingle(): Promise<SingleResult>
  single(): Promise<SingleResult>
  insert(row: Row): Promise<{ error: null }> & { select(cols?: string): { single(): Promise<SingleResult> } }
  update(patch: Row): { eq(col: string, val: unknown): Promise<{ error: null }> }
}

/**
 * A deliberately small stand-in for the PostgREST builder — only the chains
 * this module actually uses. Keeping it dumb means a test failure points at
 * the ingest logic rather than at a clever fake.
 */
class FakeDb {
  tables: Record<string, Row[]> = {
    unified_messages: [],
    unified_conversations: [],
    workspace_events: [],
  }
  inserted: Array<{ table: string; row: Row }> = []
  updated: Array<{ table: string; id: unknown; patch: Row }> = []
  private seq = 0

  from(table: string): FakeBuilder {
    const db = this
    const filters: Array<[string, unknown]> = []
    let containsFilter: { column: string; value: Row } | null = null

    const rows = (): Row[] =>
      (db.tables[table] ?? []).filter(row => {
        if (!filters.every(([col, val]) => row[col] === val)) return false
        if (containsFilter) {
          const target = (row[containsFilter.column] ?? {}) as Row
          return Object.entries(containsFilter.value).every(([k, v]) => target[k] === v)
        }
        return true
      })

    const builder: FakeBuilder = {
      select: () => builder,
      eq: (col, val) => {
        filters.push([col, val])
        return builder
      },
      contains: (col, obj) => {
        containsFilter = { column: col, value: obj }
        return builder
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: (row) => {
        const stored: Row = { id: `${table}-${++db.seq}`, ...row }
        db.tables[table] = [...(db.tables[table] ?? []), stored]
        db.inserted.push({ table, row: stored })
        // Awaited directly by some call sites, chained with
        // .select().single() by others — a real promise carrying an extra
        // method supports both without a hand-rolled thenable.
        const pending = Promise.resolve({ error: null as null }) as Promise<{ error: null }> & {
          select(cols?: string): { single(): Promise<SingleResult> }
        }
        pending.select = () => ({ single: async () => ({ data: stored, error: null }) })
        return pending
      },
      update: (patch) => ({
        eq: async (col, val) => {
          for (const row of db.tables[table] ?? []) {
            if (row[col] === val) Object.assign(row, patch)
          }
          db.updated.push({ table, id: val, patch })
          return { error: null }
        },
      }),
    }
    return builder
  }
}

function db() {
  return new FakeDb()
}
const asClient = (fake: FakeDb) => fake as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('echoMatchesRecordedCayeSend', () => {
  it('matches a send Caye recorded under Meta’s own id', async () => {
    const fake = db()
    fake.tables.unified_messages.push({ id: 'm1', channel_message_id: 'wamid.TEST_ECHO_0001' })
    expect(await echoMatchesRecordedCayeSend(asClient(fake), 'wamid.TEST_ECHO_0001')).toBe(true)
  })

  it('matches a send that kept the wamid in metadata alongside a synthetic channel id', async () => {
    const fake = db()
    fake.tables.unified_messages.push({
      id: 'm1',
      channel_message_id: 'caye_wa_1756800000000',
      metadata: { generated_by: 'caye', wa_message_id: 'wamid.TEST_ECHO_0001' },
    })
    expect(await echoMatchesRecordedCayeSend(asClient(fake), 'wamid.TEST_ECHO_0001')).toBe(true)
  })

  it('reports no match rather than guessing', async () => {
    expect(await echoMatchesRecordedCayeSend(asClient(db()), 'wamid.TEST_ECHO_0001')).toBe(false)
  })
})

describe('ingestObservedBusinessMessage — business app operator', () => {
  it('persists the observation with human authorship and full provenance', async () => {
    const fake = db()
    const observed = observedFrom('business-app-echo-text')

    const result = await ingestObservedBusinessMessage(asClient(fake), ACCOUNT, observed, 'business_app_operator')

    expect(result.outcome).toBe('observed')
    expect(result.autoReplyEligible).toBe(false)

    const message = fake.inserted.find(i => i.table === 'unified_messages')!.row
    expect(message.sender_type).toBe('business')
    expect(message.channel_message_id).toBe('wamid.TEST_ECHO_0001')
    expect(message.sent_at).toBe(observed.observedAt)
    expect(message.is_internal).toBe(false)

    const metadata = message.metadata as Row
    // authored_by drives workspace_events.actor_kind='operator' via the
    // applied trigger; sent_by is what the existing manual-outbound and
    // owner-reply readers already look for.
    expect(metadata.authored_by).toBe('human')
    expect(metadata.sent_by).toBe('human')
    expect(metadata.origin_classification).toBe('business_app_operator')
    expect(metadata.observed_via).toBe('smb_message_echoes')
    expect(metadata.source).toBe('whatsapp_business_app')
    expect(metadata.wa_message_id).toBe('wamid.TEST_ECHO_0001')
    expect(metadata.is_observation).toBe(true)
    // Never claims Caye generated it — that would poison voice learning.
    expect(metadata.generated_by).toBeUndefined()
  })

  it('records the owner as the last business sender on the same canonical conversation', async () => {
    const fake = db()
    fake.tables.unified_conversations.push({
      id: 'conv-1',
      connected_account_id: ACCOUNT.id,
      channel_conversation_id: CUSTOMER_NUMBER,
      contact_id: 'contact-9',
    })

    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-text'),
      'business_app_operator'
    )

    // Conversation continuity: reuses the customer's existing thread.
    expect(result.conversationId).toBe('conv-1')
    expect(fake.inserted.some(i => i.table === 'unified_conversations')).toBe(false)
    expect(fake.updated).toEqual([
      expect.objectContaining({
        table: 'unified_conversations',
        id: 'conv-1',
        patch: expect.objectContaining({
          last_sender_type: 'business',
          last_business_sender_kind: 'human',
        }),
      }),
    ])
  })

  it('creates the thread keyed on the customer, never on the business number', async () => {
    const fake = db()
    await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-text'),
      'business_app_operator'
    )
    const conversation = fake.inserted.find(i => i.table === 'unified_conversations')!.row
    expect(conversation.channel_conversation_id).toBe(CUSTOMER_NUMBER)
    expect(conversation.customer_id).toBe(CUSTOMER_NUMBER)
    expect(conversation.connected_account_id).toBe(ACCOUNT.id)
  })

  it('is idempotent across Meta’s webhook retries', async () => {
    const fake = db()
    const observed = observedFrom('business-app-echo-text')

    const first = await ingestObservedBusinessMessage(asClient(fake), ACCOUNT, observed, 'business_app_operator')
    const second = await ingestObservedBusinessMessage(asClient(fake), ACCOUNT, observed, 'business_app_operator')

    expect(first.outcome).toBe('observed')
    expect(second.outcome).toBe('duplicate')
    expect(fake.inserted.filter(i => i.table === 'unified_messages')).toHaveLength(1)
  })

  it('keeps a media echo as a descriptor rather than inventing text', async () => {
    const fake = db()
    await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-media'),
      'business_app_operator'
    )
    const message = fake.inserted.find(i => i.table === 'unified_messages')!.row
    expect(message.message_type).toBe('image')
    expect(message.content).toBe('Photo')
  })
})

describe('ingestObservedBusinessMessage — Caye’s own output', () => {
  it('never persists a second copy of a message Caye already recorded', async () => {
    const fake = db()
    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-text'),
      'caye_cloud_api'
    )
    expect(result.outcome).toBe('caye_authored_skipped')
    expect(result.autoReplyEligible).toBe(false)
    expect(fake.inserted).toHaveLength(0)
    expect(fake.updated).toHaveLength(0)
  })
})

describe('ingestObservedBusinessMessage — unknown authorship fails closed', () => {
  it('persists the message but claims no author and advances no sender state', async () => {
    const fake = db()
    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-text'),
      'unknown_business_origin'
    )

    expect(result.outcome).toBe('observed')
    expect(result.autoReplyEligible).toBe(false)

    const metadata = fake.inserted.find(i => i.table === 'unified_messages')!.row.metadata as Row
    expect(metadata.authorship).toBe('unresolved')
    expect(metadata.authored_by).toBeUndefined()
    expect(metadata.sent_by).toBeUndefined()
    // last_business_sender_kind is read as fact elsewhere; writing it here
    // would be a guess.
    expect(fake.updated).toHaveLength(0)
  })
})

describe('ingestObservedBusinessMessage — refuses to observe a customer message', () => {
  it('errors rather than half-persisting an external_contact routed to the observe path', async () => {
    const fake = db()
    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-text'),
      'external_contact'
    )
    expect(result.outcome).toBe('error')
    expect(fake.inserted).toHaveLength(0)
  })
})

describe('edit and revoke echoes', () => {
  function seedOriginal(fake: FakeDb) {
    fake.tables.unified_conversations.push({
      id: 'conv-1',
      connected_account_id: ACCOUNT.id,
      channel_conversation_id: CUSTOMER_NUMBER,
      contact_id: 'contact-9',
    })
    fake.tables.unified_messages.push({
      id: 'm1',
      conversation_id: 'conv-1',
      channel_message_id: 'wamid.TEST_ECHO_0001',
      content: 'Cistern is finished, we poured this morning.',
      metadata: { authored_by: 'human' },
    })
  }

  it('applies an edit without losing what was superseded', async () => {
    const fake = db()
    seedOriginal(fake)

    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-edit'),
      'business_app_operator'
    )

    expect(result.outcome).toBe('amended')
    const row = fake.tables.unified_messages[0]
    expect(row.content).toBe('Cistern is finished, we poured yesterday.')
    const edits = (row.metadata as Row).edits as Row[]
    expect(edits).toHaveLength(1)
    expect(edits[0].superseded_content).toBe('Cistern is finished, we poured this morning.')
    // Amendment, not a new message.
    expect(fake.inserted.filter(i => i.table === 'unified_messages')).toHaveLength(0)
  })

  it('marks a revoke instead of deleting anything', async () => {
    const fake = db()
    seedOriginal(fake)

    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-revoke'),
      'business_app_operator'
    )

    expect(result.outcome).toBe('amended')
    expect(fake.tables.unified_messages).toHaveLength(1)
    const metadata = fake.tables.unified_messages[0].metadata as Row
    expect(metadata.revoked_at).toBeTruthy()
    expect(fake.tables.unified_messages[0].content).toBe('Cistern is finished, we poured this morning.')
  })

  it('reports an amendment to a message it never ingested rather than inventing one', async () => {
    const fake = db()
    const result = await ingestObservedBusinessMessage(
      asClient(fake),
      ACCOUNT,
      observedFrom('business-app-echo-edit'),
      'business_app_operator'
    )
    expect(result.outcome).toBe('unresolved_reference')
    expect(fake.inserted.filter(i => i.table === 'unified_messages')).toHaveLength(0)
  })
})

describe('recordUnattributedBusinessMessage', () => {
  it('audits an unattributable business-origin message at actor_kind unknown', async () => {
    const fake = db()
    await recordUnattributedBusinessMessage(asClient(fake), {
      workspaceId: ACCOUNT.workspaceId,
      providerMessageId: 'wamid.TEST_UNKNOWN_ORIGIN_0001',
      observedAt: '2026-09-02T00:00:00.000Z',
      messageType: 'text',
      phoneNumberId: '000000000000000',
      preview: 'note to self',
    })

    const event = fake.inserted.find(i => i.table === 'workspace_events')!.row
    expect(event.actor_kind).toBe('unknown')
    expect(event.type).toBe('message.unattributed_business_origin')
    expect(event.origin).toBe('app')
    expect((event.payload as Row).origin_classification).toBe('unknown_business_origin')
    // No conversation or message is fabricated for a payload with no `to`.
    expect(fake.inserted.filter(i => i.table !== 'workspace_events')).toHaveLength(0)
  })

  it('does not audit the same provider message twice on a Meta redelivery', async () => {
    const fake = db()
    const args = {
      workspaceId: ACCOUNT.workspaceId,
      providerMessageId: 'wamid.TEST_UNKNOWN_ORIGIN_0001',
      observedAt: '2026-09-02T00:00:00.000Z',
      messageType: 'text',
      phoneNumberId: '000000000000000',
      preview: 'note to self',
    }

    await recordUnattributedBusinessMessage(asClient(fake), args)
    await recordUnattributedBusinessMessage(asClient(fake), args)

    expect(fake.inserted.filter(i => i.table === 'workspace_events')).toHaveLength(1)
  })
})
