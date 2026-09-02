import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const relationInsert = vi.fn(async () => ({ error: null }))
let accountRow: Record<string, unknown> | null = null

function chainMaybeSingle() {
  const query: any = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: accountRow, error: null }),
  }
  return query
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'connected_accounts') return chainMaybeSingle()
      if (table === 'business_artifact_relations') return { insert: relationInsert }
      throw new Error(`unexpected table in unit test: ${table}`)
    },
  }),
}))

const ingestArtifact = vi.fn()
vi.mock('./ingest', () => ({ ingestArtifact }))
vi.mock('./process', () => ({ processArtifact: vi.fn() }))

const {
  fetchGmailAttachmentBytes,
  fetchZohoAttachmentBytes,
  gmailAttachmentDescriptors,
  ingestNormalizedEmailAttachment,
  relateEmailArtifactToFreightRequest,
} = await import('./email-attachments')

describe('email attachment provider boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    relationInsert.mockClear()
    ingestArtifact.mockClear()
    accountRow = null
  })

  it('normalizes nested Gmail attachment metadata without fetching bytes', () => {
    const descriptors = gmailAttachmentDescriptors({
      workspaceId: 'ws-1',
      connectedAccountId: 'acct-1',
      conversationId: 'conv-1',
      unifiedMessageId: 'umsg-1',
      message: {
        id: 'gmail-msg-123',
        threadId: 'gmail-thread-7',
        internalDate: '1788386400000',
        payload: {
          headers: [
            { name: 'From', value: 'King Ocean <ops@kingocean.example>' },
            { name: 'Subject', value: 'Please see attached DOCK RECEIPT' },
          ],
          parts: [{
            mimeType: 'multipart/mixed',
            parts: [{
              filename: 'DOCK_RECEIPT_DR-12345.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'att-55', size: 42191 },
            }],
          }],
        },
      },
    })

    expect(descriptors).toEqual([expect.objectContaining({
      workspaceId: 'ws-1',
      connectedAccountId: 'acct-1',
      provider: 'gmail',
      providerMessageId: 'gmail-msg-123',
      providerThreadId: 'gmail-thread-7',
      providerAttachmentId: 'att-55',
      filename: 'DOCK_RECEIPT_DR-12345.pdf',
      mimeType: 'application/pdf',
      size: 42191,
      sender: 'King Ocean <ops@kingocean.example>',
      subject: 'Please see attached DOCK RECEIPT',
      conversationId: 'conv-1',
      unifiedMessageId: 'umsg-1',
    })])
  })

  it('bounds Gmail MIME attachment discovery to twenty attachments', () => {
    const descriptors = gmailAttachmentDescriptors({
      workspaceId: 'ws-1', connectedAccountId: 'acct-1',
      message: {
        id: 'gmail-msg-bounded', threadId: 'thread',
        payload: { parts: Array.from({ length: 25 }, (_, i) => ({ filename: `f-${i}.pdf`, mimeType: 'application/pdf', body: { attachmentId: `a-${i}`, size: 1 } })) },
      },
    })
    expect(descriptors).toHaveLength(20)
  })

  it('fetches exactly one Gmail attachment endpoint and decodes base64url bytes', async () => {
    const payload = Buffer.from('sanitized dock receipt bytes').toString('base64url')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: payload, size: 28 }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const bytes = await fetchGmailAttachmentBytes({
      workspaceId: 'ws-1', connectedAccountId: 'acct-1', provider: 'gmail', providerMessageId: 'msg/a', providerThreadId: 't', providerAttachmentId: 'att+b', filename: 'x.pdf', mimeType: 'application/pdf', size: 28, sender: null, subject: null, receivedAt: null, conversationId: null, unifiedMessageId: null,
    }, 'token-123')

    expect(bytes.toString()).toBe('sanitized dock receipt bytes')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2Fa/attachments/att%2Bb',
      { headers: { Authorization: 'Bearer token-123' } },
    )
    vi.unstubAllGlobals()
  })

  it('fails closed for an unverified Zoho attachment byte path', async () => {
    await expect(fetchZohoAttachmentBytes({
      workspaceId: 'ws-1', connectedAccountId: 'acct-z', provider: 'zoho', providerMessageId: 'z-msg', providerThreadId: null, providerAttachmentId: 'z-att', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 1, sender: null, subject: null, receivedAt: null, conversationId: null, unifiedMessageId: null,
    })).rejects.toThrow('ZOHO_ATTACHMENT_FETCH_UNSUPPORTED')
  })

  it('rejects cross-workspace/account attachment ingestion before artifact storage', async () => {
    accountRow = null
    await expect(ingestNormalizedEmailAttachment({
      descriptor: {
        workspaceId: 'ws-other', connectedAccountId: 'acct-1', provider: 'gmail', providerMessageId: 'msg-1', providerThreadId: 'thread-1', providerAttachmentId: 'att-1', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 4, sender: null, subject: null, receivedAt: null, conversationId: null, unifiedMessageId: null,
      },
      bytes: Buffer.from('test'),
    })).rejects.toThrow('account/workspace validation failed')
    expect(ingestArtifact).not.toHaveBeenCalled()
  })
})

describe('freight evidence role relations', () => {
  beforeEach(() => relationInsert.mockClear())

  it('relates dock receipts as shipment evidence, never purchase evidence', async () => {
    await relateEmailArtifactToFreightRequest({ workspaceId: 'ws-1', artifactId: 'dock-art', freightRequestId: 'freight-1', documentType: 'dock_receipt' })
    expect(relationInsert).toHaveBeenCalledTimes(1)
    expect(relationInsert.mock.calls[0][0]).toMatchObject({ relation_type: 'evidence_for', target_entity_type: 'freight_request', target_entity_id: 'freight-1', status: 'candidate' })
  })

  it('relates vendor receipts as purchase candidates', async () => {
    await relateEmailArtifactToFreightRequest({ workspaceId: 'ws-1', artifactId: 'purchase-art', freightRequestId: 'freight-1', documentType: 'vendor_receipt' })
    expect(relationInsert).toHaveBeenCalledTimes(1)
    expect(relationInsert.mock.calls[0][0]).toMatchObject({ relation_type: 'candidate_purchase_evidence_for', target_entity_type: 'freight_request', status: 'candidate' })
  })

  it('creates no trusted purchase relation for quotes', async () => {
    await relateEmailArtifactToFreightRequest({ workspaceId: 'ws-1', artifactId: 'quote-art', freightRequestId: 'freight-1', documentType: 'quote' })
    expect(relationInsert).not.toHaveBeenCalled()
  })
})
