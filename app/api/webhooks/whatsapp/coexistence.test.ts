import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * End-to-end proof for the WhatsApp coexistence ingestion contract, driven
 * through the real route processor with sanitized Meta fixtures.
 *
 * The load-bearing assertion in most of these is a NEGATIVE one: that
 * generateCayeAutoReply and sendWhatsAppMessage were never called. Observing
 * the owner's own WhatsApp Business app must never produce a customer-facing
 * message.
 */

type Row = Record<string, unknown>

const FIXTURES = path.join(process.cwd(), 'lib', 'whatsapp', 'fixtures', 'coexistence')
const PHONE_NUMBER_ID = '000000000000000'
const BUSINESS_NUMBER = '15550000001'
const CUSTOMER_NUMBER = '15550000042'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))
}

interface SingleResult {
  data: Row | null
  error: null
}

type WithSelect<T> = Promise<T> & {
  select(cols?: string): {
    single(): Promise<SingleResult>
    maybeSingle(): Promise<SingleResult>
  }
}

interface FakeBuilder {
  select(cols?: string, opts?: unknown): FakeBuilder
  eq(col: string, val: unknown): FakeBuilder
  contains(col: string, obj: Row): FakeBuilder
  maybeSingle(): Promise<SingleResult>
  single(): Promise<SingleResult>
  /** Thenable so a head/count query resolves without a terminator. */
  then(resolve: (value: { data: Row[]; count: number; error: null }) => unknown): Promise<unknown>
  insert(row: Row): WithSelect<{ error: null }>
  upsert(row: Row, opts: { onConflict: string }): WithSelect<{ error: null }>
  update(patch: Row): { eq(col: string, val: unknown): WithSelect<{ error: null }> }
}

/** Minimal PostgREST-shaped fake — only the chains this route actually uses. */
class FakeDb {
  tables: Record<string, Row[]> = emptyTables()
  inserted: Array<{ table: string; row: Row }> = []
  updated: Array<{ table: string; patch: Row }> = []
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

    const store = (row: Row): Row => {
      const stored: Row = { id: `${table}-${++db.seq}`, ...row }
      db.tables[table] = [...(db.tables[table] ?? []), stored]
      db.inserted.push({ table, row: stored })
      return stored
    }

    const withSelect = (stored: () => Row | null): WithSelect<{ error: null }> =>
      Object.assign(Promise.resolve({ error: null as null }), {
        select: () => ({
          single: async (): Promise<SingleResult> => ({ data: stored(), error: null }),
          maybeSingle: async (): Promise<SingleResult> => ({ data: stored(), error: null }),
        }),
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
      then: resolve => Promise.resolve({ data: rows(), count: rows().length, error: null as null }).then(resolve),
      insert: row => {
        const stored = store(row)
        return withSelect(() => stored)
      },
      upsert: (row, opts) => {
        const keys = opts.onConflict.split(',').map(k => k.trim())
        const match = (db.tables[table] ?? []).find(existing => keys.every(k => existing[k] === row[k]))
        const stored = match ? Object.assign(match, row) : store(row)
        return withSelect(() => stored)
      },
      update: patch => ({
        eq: (col, val) => {
          let touched: Row | null = null
          for (const row of db.tables[table] ?? []) {
            if (row[col] === val) {
              Object.assign(row, patch)
              touched = row
            }
          }
          db.updated.push({ table, patch })
          return withSelect(() => touched)
        },
      }),
    }
    return builder
  }
}

function emptyTables(): Record<string, Row[]> {
  return {
    connected_accounts: [],
    workspace_ai_config: [],
    customers: [],
    unified_conversations: [],
    unified_messages: [],
    workspace_events: [],
    caye_outbound_queue: [],
  }
}

const fake = new FakeDb()

const { sendWhatsAppMessage, generateCayeAutoReply } = vi.hoisted(() => ({
  sendWhatsAppMessage: vi.fn(
    async (_to: string, _body: string, _phoneNumberId: string, _accessToken: string): Promise<string | null> =>
      'wamid.TEST_CAYE_REPLY_0001'
  ),
  generateCayeAutoReply: vi.fn(async (): Promise<{ action: string; content: string }> => ({
    action: 'reply',
    content: 'On it.',
  })),
}))

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake }))
vi.mock('@/lib/whatsapp', () => ({ sendWhatsAppMessage }))
vi.mock('@/lib/caye-reply', () => ({ generateCayeAutoReply }))
vi.mock('@/lib/whatsapp/triggers', () => ({
  enqueueHoldPing: vi.fn(async () => {}),
  enqueueBookingCreated: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/escalation', () => ({ applyEscalation: async (decision: unknown) => decision }))
vi.mock('@/lib/whatsapp/urgency', () => ({ extractHoldTargetDate: () => null }))
vi.mock('@/lib/contact-profile', () => ({ maybeRefreshContactProfile: vi.fn(async () => {}) }))
vi.mock('@/lib/calendar-sync', () => ({ syncBookingToCalendar: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/founder-alert', () => ({ alertFounderOfDeliveryFailure: vi.fn(async () => {}) }))
vi.mock('@/app/api/caye/outbound-worker/route', () => ({ OPERATOR_LOGGABLE_KINDS: new Set<string>() }))
vi.mock('@/lib/contacts/resolve-contact', () => ({
  resolveOrCreateContact: vi.fn(async () => ({ id: 'contact-1' })),
}))

import { processInboundWhatsApp } from './route'

const messagesInserted = () => fake.inserted.filter(i => i.table === 'unified_messages').map(i => i.row)

beforeEach(() => {
  fake.tables = emptyTables()
  fake.tables.connected_accounts.push({
    id: 'account-1',
    user_id: 'workspace-1',
    channel_type: 'whatsapp',
    channel_account_id: PHONE_NUMBER_ID,
    access_token: 'redacted-test-token',
    is_active: true,
    metadata: { business_phone: BUSINESS_NUMBER },
  })
  fake.tables.workspace_ai_config.push({ workspace_id: 'workspace-1', system_prompt: 'Be helpful.', ai_enabled: true })
  fake.tables.customers.push({ id: 'workspace-1', ai_voice_profile: null })
  fake.inserted = []
  fake.updated = []
  vi.clearAllMocks()
  sendWhatsAppMessage.mockResolvedValue('wamid.TEST_CAYE_REPLY_0001')
  generateCayeAutoReply.mockResolvedValue({ action: 'reply', content: 'On it.' })
})

describe('ordinary customer inbound is unchanged', () => {
  it('still generates and sends an auto-reply', async () => {
    await processInboundWhatsApp(fixture('external-inbound-text'))

    expect(generateCayeAutoReply).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppMessage.mock.calls[0][0]).toBe(CUSTOMER_NUMBER)

    const inbound = messagesInserted().find(m => m.sender_type === 'customer')
    expect(inbound?.channel_message_id).toBe('wamid.TEST_EXTERNAL_0001')

    const outbound = messagesInserted().find(m => m.sender_type === 'business')
    // Meta's own id is now kept so a coexistence echo of this send reconciles.
    expect((outbound?.metadata as Row).wa_message_id).toBe('wamid.TEST_CAYE_REPLY_0001')
  })
})

describe('a human WhatsApp Business app message is observed, never answered', () => {
  it('persists the owner message with human authorship and sends nothing', async () => {
    await processInboundWhatsApp(fixture('business-app-echo-text'))

    expect(generateCayeAutoReply).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()

    const observed = messagesInserted()
    expect(observed).toHaveLength(1)
    expect(observed[0].sender_type).toBe('business')
    expect(observed[0].channel_message_id).toBe('wamid.TEST_ECHO_0001')
    const metadata = observed[0].metadata as Row
    expect(metadata.authored_by).toBe('human')
    expect(metadata.origin_classification).toBe('business_app_operator')
    expect(metadata.is_observation).toBe(true)
  })

  it('lands on the existing customer conversation instead of forking one', async () => {
    fake.tables.unified_conversations.push({
      id: 'conv-1',
      connected_account_id: 'account-1',
      channel_conversation_id: CUSTOMER_NUMBER,
      customer_name: 'Test Customer',
      contact_id: 'contact-9',
    })

    await processInboundWhatsApp(fixture('business-app-echo-text'))

    expect(fake.inserted.filter(i => i.table === 'unified_conversations')).toHaveLength(0)
    expect(messagesInserted()[0].conversation_id).toBe('conv-1')
    // The real contact name survives; an echo carries no profile name.
    expect(fake.tables.unified_conversations[0].customer_name).toBe('Test Customer')
    expect(fake.tables.unified_conversations[0].last_business_sender_kind).toBe('human')
  })

  it('is idempotent when Meta redelivers the same echo', async () => {
    await processInboundWhatsApp(fixture('business-app-echo-text'))
    await processInboundWhatsApp(fixture('business-app-echo-text'))

    expect(messagesInserted()).toHaveLength(1)
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})

describe('a Caye-originated message cannot loop back through the reply path', () => {
  it('recognises an echo of a send Caye already recorded and stores nothing new', async () => {
    fake.tables.unified_messages.push({
      id: 'm1',
      conversation_id: 'conv-1',
      channel_message_id: 'caye_wa_1756800600000',
      sender_type: 'business',
      metadata: { generated_by: 'caye', wa_message_id: 'wamid.TEST_ECHO_0001' },
    })

    await processInboundWhatsApp(fixture('business-app-echo-text'))

    expect(generateCayeAutoReply).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(messagesInserted()).toHaveLength(0)
  })
})

describe('a message from the business number on the messages field fails closed', () => {
  it('audits it at unknown authorship without replying or fabricating a thread', async () => {
    await processInboundWhatsApp(fixture('business-number-messages-entry'))

    expect(generateCayeAutoReply).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(messagesInserted()).toHaveLength(0)
    expect(fake.inserted.filter(i => i.table === 'unified_conversations')).toHaveLength(0)

    const event = fake.inserted.find(i => i.table === 'workspace_events')?.row
    expect(event?.actor_kind).toBe('unknown')
    expect(event?.type).toBe('message.unattributed_business_origin')
  })
})

describe('batched delivery of a customer message and an owner echo', () => {
  it('answers only the customer, and observes only the owner', async () => {
    await processInboundWhatsApp(fixture('batched-inbound-and-echo'))

    expect(generateCayeAutoReply).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1)

    const byId = new Map(messagesInserted().map(m => [m.channel_message_id, m]))
    expect(byId.has('wamid.TEST_EXTERNAL_0002')).toBe(true)
    expect(byId.has('wamid.TEST_ECHO_0002')).toBe(true)
    expect((byId.get('wamid.TEST_ECHO_0002')?.metadata as Row).authored_by).toBe('human')
  })
})

describe('delivery-status handling is intact', () => {
  it('still writes Meta status onto the matching outbound queue row', async () => {
    fake.tables.caye_outbound_queue.push({
      id: 'q1',
      workspace_id: 'workspace-1',
      kind: 'operator_message',
      wa_message_id: 'wamid.TEST_CAYE_SEND_0001',
    })

    await processInboundWhatsApp(fixture('delivery-status'))

    expect(fake.tables.caye_outbound_queue[0].wa_delivery_status).toBe('read')
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(messagesInserted()).toHaveLength(0)
  })
})

describe('coexistence fields this milestone does not ingest', () => {
  it('ignores history and smb_app_state_sync without throwing or writing', async () => {
    await expect(processInboundWhatsApp(fixture('history'))).resolves.toBeUndefined()
    await expect(processInboundWhatsApp(fixture('smb-app-state-sync'))).resolves.toBeUndefined()
    await expect(processInboundWhatsApp(fixture('unrecognized-field'))).resolves.toBeUndefined()

    expect(fake.inserted).toHaveLength(0)
    expect(generateCayeAutoReply).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})
