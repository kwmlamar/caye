import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/server', () => ({
  NextRequest: class NextRequest {},
  NextResponse: { json: (value: unknown) => value },
}))

const account = {
  id: 'acct-1',
  user_id: 'ws-1',
  channel_account_name: 'owner@example.com',
  access_token: 'token-1',
  token_expires_at: '2099-01-01T00:00:00.000Z',
  updated_at: '2026-09-02T18:00:00.000Z',
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

const ingestNormalizedEmailAttachment = vi.fn()
vi.mock('@/lib/artifacts/email-attachments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/artifacts/email-attachments')>('@/lib/artifacts/email-attachments')
  return {
    ...actual,
    ingestNormalizedEmailAttachment: ingestNormalizedEmailAttachment,
  }
})

const reconcileFreightEmailAttachmentEvidence = vi.fn(async () => ({ freightRequestId: 'freight-1', purchaseCandidates: 0, shipmentEvidence: 1 }))
vi.mock('@/lib/freight/email-attachment-reconciliation', () => ({ reconcileFreightEmailAttachmentEvidence }))

const { processGmailMessage } = await import('./route')
const { syncRecentGmailAttachmentEvidence } = await import('@/lib/artifacts/gmail-attachment-sync')
const { fetchGmailAttachmentBytes } = await import('@/lib/artifacts/email-attachments')

function headers(subject = 'Please see attached DOCK RECEIPT') {
  return [
    { name: 'From', value: 'King Ocean <ops@kingocean.example>' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: '<provider-1@example>' },
  ]
}

function plainBody(text: string) {
  return Buffer.from(text).toString('base64url')
}

function attachmentMessage(nested = false) {
  const pdf = { filename: 'DOCK_RECEIPT_DR-12345.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 24 } }
  return {
    id: nested ? 'gmail-nested' : 'gmail-direct',
    threadId: nested ? 'thread-nested' : 'thread-direct',
    internalDate: String(new Date('2026-09-02T17:00:00.000Z').getTime()),
    payload: {
      headers: headers(),
      mimeType: 'multipart/mixed',
      parts: nested ? [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'multipart/mixed', parts: [pdf] }] }] : [pdf],
    },
  }
}

describe('Gmail attachment-only inbound persistence', () => {
  beforeEach(() => {
    harness = makeDb()
    ingestNormalizedEmailAttachment.mockReset()
    reconcileFreightEmailAttachmentEvidence.mockClear()
    vi.unstubAllGlobals()
  })

  it('persists an attachment-only Gmail message with a direct PDF', async () => {
    const result = await processGmailMessage(harness.db, account, attachmentMessage(false) as any, 'token-1')
    expect(result).toBe('processed')
    expect(harness.state.messages).toHaveLength(1)
    expect(harness.state.messages[0]).toMatchObject({ channel_message_id: 'gmail-direct', content: '' })
    expect(harness.state.conversations).toHaveLength(1)
  })

  it('persists an attachment-only Gmail message with a nested multipart PDF', async () => {
    const result = await processGmailMessage(harness.db, account, attachmentMessage(true) as any, 'token-1')
    expect(result).toBe('processed')
    expect(harness.state.messages.map(row => row.channel_message_id)).toContain('gmail-nested')
  })

  it('keeps truly empty Gmail messages filtered', async () => {
    const result = await processGmailMessage(harness.db, account, {
      id: 'gmail-empty', threadId: 'thread-empty', internalDate: String(new Date('2026-09-02T17:00:00.000Z').getTime()),
      payload: { headers: headers('Empty'), mimeType: 'multipart/alternative', parts: [] },
    } as any, 'token-1')
    expect(result).toBe('skipped')
    expect(harness.state.messages).toHaveLength(0)
  })

  it('keeps normal text Gmail persistence unchanged', async () => {
    const result = await processGmailMessage(harness.db, account, {
      id: 'gmail-text', threadId: 'thread-text', internalDate: String(new Date('2026-09-02T17:00:00.000Z').getTime()),
      payload: { headers: headers('Hello'), mimeType: 'text/plain', body: { data: plainBody('hello there') } },
    } as any, 'token-1')
    expect(result).toBe('processed')
    expect(harness.state.messages[0]?.content).toBe('hello there')
  })

  it('keeps HTML-only Gmail persistence unchanged', async () => {
    const result = await processGmailMessage(harness.db, account, {
      id: 'gmail-html', threadId: 'thread-html', internalDate: String(new Date('2026-09-02T17:00:00.000Z').getTime()),
      payload: { headers: headers('HTML'), mimeType: 'text/html', body: { data: plainBody('<p>Hello <strong>there</strong></p>') } },
    } as any, 'token-1')
    expect(result).toBe('processed')
    expect(harness.state.messages[0]?.content).toContain('Hello')
  })

  it('replaying the same provider message does not duplicate unified_message', async () => {
    const message = attachmentMessage(false)
    expect(await processGmailMessage(harness.db, account, message as any, 'token-1')).toBe('processed')
    expect(await processGmailMessage(harness.db, account, message as any, 'token-1')).toBe('skipped')
    expect(harness.state.messages.filter(row => row.channel_message_id === 'gmail-direct')).toHaveLength(1)
  })

  it('takes a persisted attachment-only message through bounded descriptor and provider-byte sync', async () => {
    const message = attachmentMessage(false)
    expect(await processGmailMessage(harness.db, account, message as any, 'token-1')).toBe('processed')

    ingestNormalizedEmailAttachment.mockImplementationOnce(async ({ descriptor, accessToken }: any) => {
      const bytes = await fetchGmailAttachmentBytes(descriptor, accessToken)
      expect(bytes.toString()).toBe('sanitized dock receipt bytes')
      return { artifactId: 'artifact-dock-1', documentType: 'dock_receipt', deduped: false }
    })

    const attachmentBytes = Buffer.from('sanitized dock receipt bytes').toString('base64url')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/messages/gmail-direct?format=full')) {
        return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/messages/gmail-direct/attachments/att-1')) {
        return new Response(JSON.stringify({ data: attachmentBytes, size: 28 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    const stats = await syncRecentGmailAttachmentEvidence()
    expect(stats.messages).toBe(1)
    expect(stats.attachments).toBe(1)
    expect(stats.errors).toBe(0)
    expect(ingestNormalizedEmailAttachment).toHaveBeenCalledWith(expect.objectContaining({
      descriptor: expect.objectContaining({
        providerMessageId: 'gmail-direct',
        providerAttachmentId: 'att-1',
        unifiedMessageId: harness.state.messages[0].id,
        conversationId: harness.state.conversations[0].id,
      }),
      accessToken: 'token-1',
    }))
    expect(reconcileFreightEmailAttachmentEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: 'gmail-direct',
      unifiedMessageId: harness.state.messages[0].id,
      body: '',
    }))
  })
})
