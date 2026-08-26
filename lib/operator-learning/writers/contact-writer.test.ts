import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let existingAllowlistRow: { id: string; role: string; verified_at: string | null; phone: string } | null = null
let insertedRows: Record<string, unknown>[] = []
let insertError: { message: string } | null = null
let sentTemplates: { phone: string; template: string; placeholders: string[] }[] = []

vi.mock('@/lib/whatsapp/outbound', () => ({
  sendTemplateWhatsApp: async (phone: string, template: string, placeholders: string[]) => {
    sentTemplates.push({ phone, template, placeholders })
    return { status: 'sent', messageId: 'wamid.test' }
  },
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'operator_allowlist') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: existingAllowlistRow, error: null }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (insertError) return { data: null, error: insertError }
                insertedRows.push(row)
                return { data: { id: 'allowlist-new' }, error: null }
              },
            }),
          }),
        }
      }
      if (table === 'whatsapp_templates') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'approved' }, error: null }) }) }) }
      }
      if (table === 'customers') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { business_name: 'Bimini Island Tours' }, error: null }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

const { writeContact } = await import('./contact-writer')
const { validateClassification } = await import('../schema')

function classification(contact: Record<string, unknown>) {
  const res = validateClassification({
    learnable: true,
    explicitness: 'explicit_statement',
    scope: { kind: 'standing', target: 'person', serviceName: null, dateISO: null },
    risk: 'low',
    destination: 'contact',
    canonicalKey: 'max-driver-contact',
    confidence: 0.95,
    rationale: 'owner introduced a new driver',
    contact,
  })
  if (!res.ok) throw new Error(`bad fixture: ${res.reason}`)
  return res.value
}

beforeEach(() => {
  existingAllowlistRow = null
  insertedRows = []
  insertError = null
  sentTemplates = []
})

describe('writeContact', () => {
  it('adds a new driver contact, inert (verified_at null) until they consent (Bimini: Max the driver)', async () => {
    const c = classification({ name: 'Max', phone: '242-473-0233', role: 'driver' })
    const outcome = await writeContact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('written')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toMatchObject({ role: 'driver', name: 'Max', verified_at: null })
    expect(sentTemplates[0].template).toBe('caye_driver_consent')
  })

  it('is idempotent for a duplicate webhook delivery: same phone already on the allowlist is a no_op, not a second row', async () => {
    existingAllowlistRow = { id: 'existing', role: 'driver', verified_at: null, phone: '+12424730233' }
    const c = classification({ name: 'Max', phone: '242-473-0233', role: 'driver' })
    const outcome = await writeContact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('no_op')
    expect(insertedRows).toHaveLength(0)
  })

  it('holds as candidate when the phone number does not normalize', async () => {
    const c = classification({ name: 'Max', phone: 'not-a-phone', role: 'driver' })
    const outcome = await writeContact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('candidate')
    expect(insertedRows).toHaveLength(0)
  })

  it('surfaces an insert error as decision=error, never a fabricated success', async () => {
    insertError = { message: 'constraint violation' }
    const c = classification({ name: 'Max', phone: '242-473-0233', role: 'driver' })
    const outcome = await writeContact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('error')
  })
})
