import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/server', () => ({
  NextRequest: class NextRequest {},
  NextResponse: { json: (value: unknown) => value },
}))

/**
 * Proves the payment-watcher hook cannot break Gmail polling. It sits on the
 * single path every inbound message already takes (see the hook's own
 * comment in route.ts), so a throw inside it must be caught, logged, and
 * polling must continue exactly as if the hook were not there at all.
 */

const account = {
  id: 'acct-1',
  user_id: 'ws-1',
  channel_account_name: 'owner@example.com',
  access_token: 'token-1',
  token_expires_at: '2099-01-01T00:00:00.000Z',
  // AFTER the test message's internalDate, so the message is treated as
  // historical (received before this account connected) — same convention
  // attachment-only.test.ts uses to reach the plain 'processed' persistence
  // path without also exercising the auto-reply decision, which is not what
  // this test is about.
  updated_at: '2026-09-05T00:00:00.000Z',
  is_active: true,
}

type Row = Record<string, any>

function makeDb() {
  const state = {
    messages: [] as Row[],
    conversations: [] as Row[],
    nextConversation: 1,
    nextMessage: 1,
  }

  class Query {
    table: string
    action: 'select' | 'insert' | 'update' = 'select'
    filters: Array<[string, unknown]> = []
    payload: any = null

    constructor(table: string) { this.table = table }
    select(_columns?: string) { if (this.action !== 'insert') this.action = 'select'; return this }
    eq(column: string, value: unknown) { this.filters.push([column, value]); return this }
    in(column: string, values: unknown[]) { this.filters.push([column, values]); return this }
    not(_column: string, _op: string, _value: unknown) { return this }
    order(_column: string, _opts?: unknown) { return this }
    limit(_value: number) { return this }
    is(_column: string, _value: unknown) { return this }
    insert(payload: any) { this.action = 'insert'; this.payload = payload; return this }
    update(payload: any) { this.action = 'update'; this.payload = payload; return this }

    private matches(row: Row) {
      return this.filters.every(([column, value]) => {
        if (Array.isArray(value)) return value.includes(row[column])
        return row[column] === value
      })
    }

    private async result() {
      if (this.action === 'select') {
        if (this.table === 'connected_accounts') return { data: [account], error: null }
        if (this.table === 'unified_messages') return { data: state.messages.filter(row => this.matches(row)), error: null }
        if (this.table === 'unified_conversations') return { data: state.conversations.filter(row => this.matches(row)), error: null }
        if (this.table === 'workspace_ai_config') return { data: [], error: null }
        if (this.table === 'customers') return { data: [], error: null }
        return { data: [], error: null }
      }
      if (this.action === 'update') {
        const rows = this.table === 'unified_conversations' ? state.conversations : state.messages
        for (const row of rows.filter(row => this.matches(row))) Object.assign(row, this.payload)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }

    async maybeSingle() {
      if (this.table === 'unified_messages') {
        return { data: state.messages.find(row => this.matches(row)) ?? null, error: null }
      }
      if (this.table === 'unified_conversations') {
        return { data: state.conversations.find(row => this.matches(row)) ?? null, error: null }
      }
      return { data: null, error: null }
    }

    async single() {
      if (this.action === 'insert' && this.table === 'unified_conversations') {
        const row = { id: `conv-${state.nextConversation++}`, metadata: this.payload.metadata ?? {}, ...this.payload }
        state.conversations.push(row)
        return { data: row, error: null }
      }
      return { data: null, error: null }
    }

    then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
      return this.execute().then(resolve, reject)
    }

    private async execute() {
      if (this.action === 'insert' && this.table === 'unified_messages') {
        const row = { id: `msg-${state.nextMessage++}`, ...this.payload }
        state.messages.push(row)
        return { data: row, error: null }
      }
      return this.result()
    }
  }

  const db = { from: (table: string) => new Query(table) }
  return { db: db as any, state }
}

let harness = makeDb()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => harness.db }))
vi.mock('@/lib/caye-reply', () => ({ generateCayeAutoReply: vi.fn(async () => ({ action: 'ignore', reason: 'test' })) }))
vi.mock('@/lib/voice-profile', () => ({ ensureTagline: (text: string) => text }))
vi.mock('@/lib/whatsapp/triggers', () => ({ enqueueHoldPing: vi.fn(), enqueueBookingCreated: vi.fn() }))
vi.mock('@/lib/calendar-sync', () => ({ syncBookingToCalendar: vi.fn() }))
vi.mock('@/lib/whatsapp/escalation', () => ({ applyEscalation: vi.fn(async (decision: unknown) => decision) }))
vi.mock('@/lib/hold-kinds', () => ({ mergeHoldKind: vi.fn(async () => ({})) }))
vi.mock('@/lib/whatsapp/urgency', () => ({ extractHoldTargetDate: vi.fn(() => null) }))
vi.mock('@/lib/gmail-send', () => ({ sendGmailReply: vi.fn() }))
vi.mock('@/lib/sender-classifier', () => ({
  isNoReplySender: vi.fn(() => false),
  isCalendarInvite: vi.fn(() => false),
  isOutOfOffice: vi.fn(() => false),
}))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: vi.fn(async (_name: string, fn: () => unknown) => fn()) }))
vi.mock('@/lib/contacts/resolve-contact', () => ({ resolveOrCreateContact: vi.fn(async () => ({ id: 'contact-1' })) }))
vi.mock('@/lib/artifacts/email-attachments', () => ({ gmailAttachmentDescriptors: vi.fn(() => []) }))

const proposePaymentMatch = vi.fn(async () => {
  throw new Error('boom: simulated payment-watcher failure')
})
vi.mock('@/lib/payment-watcher/propose', () => ({ proposePaymentMatch }))

const { processGmailMessage } = await import('./route')

function headers(subject: string) {
  return [
    { name: 'From', value: 'Client <client@example.com>' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: '<provider-1@example>' },
  ]
}

function plainBody(text: string) {
  return Buffer.from(text).toString('base64url')
}

describe('gmail-poll payment-watcher hook resilience', () => {
  beforeEach(() => {
    harness = makeDb()
    proposePaymentMatch.mockClear()
  })

  it('continues processing and persists the message when the payment-watcher hook throws', async () => {
    const message = {
      id: 'gmail-1',
      threadId: 'thread-1',
      internalDate: String(new Date('2026-09-04T17:00:00.000Z').getTime()),
      payload: {
        headers: headers('We wired $3,200 today'),
        mimeType: 'text/plain',
        body: { data: plainBody('We wired $3,200 today, ref INV-102.') },
      },
    }

    const result = await processGmailMessage(harness.db, account, message as any, 'token-1')

    expect(proposePaymentMatch).toHaveBeenCalledTimes(1)
    expect(result).toBe('processed')
    expect(harness.state.messages).toHaveLength(1)
    expect(harness.state.messages[0]).toMatchObject({ channel_message_id: 'gmail-1' })
    expect(harness.state.conversations).toHaveLength(1)
  })
})
