import { describe, it, expect } from 'vitest'
import { resolveOrCreateContact, isEmailShaped, type SupabaseLike } from './resolve-contact'

/** Minimal in-memory fake covering only what resolveOrCreateContact calls:
 *  .from('contacts').upsert(row, {onConflict}).select().single(). Dedup is
 *  keyed by the same columns the real partial unique indexes use, so a
 *  second upsert with the same identity returns the same row id instead of
 *  creating a new one — the property the real DB constraints guarantee. */
function makeFakeContacts() {
  const rows: Record<string, unknown>[] = []
  let nextId = 1

  const supabase: SupabaseLike = {
    from(table) {
      if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
      return {
        upsert(row, opts) {
          const keyCols = opts.onConflict.split(',')
          const existing = rows.find((r) => keyCols.every((c) => r[c] === row[c]))
          let saved: Record<string, unknown>
          if (existing) {
            Object.assign(existing, row)
            saved = existing
          } else {
            saved = { id: `contact-${nextId++}`, ...row }
            rows.push(saved)
          }
          return {
            select() {
              return {
                async single() {
                  return { data: { id: saved.id as string }, error: null }
                },
              }
            },
          }
        },
      }
    },
  }

  return { supabase, rows }
}

describe('resolveOrCreateContact', () => {
  it('creates a contact for a new email sender (website intake / Karin regression)', async () => {
    const { supabase, rows } = makeFakeContacts()
    const result = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1',
      channelType: 'email',
      channelId: 'karinroberts63@gmail.com',
      name: 'Karin Roberts',
      at: '2026-08-13T06:14:20.578Z',
    })
    expect(result).not.toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      customer_id: 'ws-1',
      email: 'karinroberts63@gmail.com',
      name: 'Karin Roberts',
      channel_type: 'email',
    })
  })

  it('is idempotent — same email resolves to the same contact id, no duplicate row', async () => {
    const { supabase, rows } = makeFakeContacts()
    const first = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'email', channelId: 'jane@example.com', name: 'Jane', at: 't1',
    })
    const second = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'gmail', channelId: 'JANE@example.com', name: 'Jane Doe', at: 't2',
    })
    expect(second?.id).toBe(first?.id)
    expect(rows).toHaveLength(1)
  })

  it('returns null for an automated/noreply sender — no Person created', async () => {
    const { supabase, rows } = makeFakeContacts()
    const result = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'email', channelId: 'noreply@chargeanywhere.com', name: null, at: 't1',
    })
    expect(result).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it('scopes dedup per workspace — same email in two workspaces is two contacts', async () => {
    const { supabase, rows } = makeFakeContacts()
    await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'email', channelId: 'shared@example.com', name: 'A', at: 't1',
    })
    await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-2', channelType: 'email', channelId: 'shared@example.com', name: 'A', at: 't1',
    })
    expect(rows).toHaveLength(2)
  })

  it('resolves a social-channel identity keyed by (workspace, channel_type, channel_id)', async () => {
    const { supabase, rows } = makeFakeContacts()
    const first = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'whatsapp', channelId: '+12425551234', name: 'Guest', at: 't1',
    })
    const second = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'whatsapp', channelId: '+12425551234', name: 'Guest Renamed', at: 't2',
    })
    expect(second?.id).toBe(first?.id)
    expect(rows).toHaveLength(1)
  })

  it('does not gate social channels through the email noreply classifier', async () => {
    // A WhatsApp channelId is a phone number, not an email — isNoReplySender
    // must never be consulted for non-email channels.
    const { supabase, rows } = makeFakeContacts()
    const result = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'whatsapp', channelId: '+1noreply5551234', name: 'Guest', at: 't1',
    })
    expect(result).not.toBeNull()
    expect(rows).toHaveLength(1)
  })

  it('rejects a non-email-shaped identity on an email channel (ambiguous, not a strong identifier)', async () => {
    // Real production shape: Zoho payment-receipt synthetic customer_id
    // ("receipt_000152955956") landing in unified_conversations.customer_id
    // with no real email behind it. Must not silently become a Person.
    const { supabase, rows } = makeFakeContacts()
    const result = await resolveOrCreateContact(supabase, {
      workspaceId: 'ws-1', channelType: 'email', channelId: 'receipt_000152955956', name: 'Kyra Aviles', at: 't1',
    })
    expect(result).toBeNull()
    expect(rows).toHaveLength(0)
  })
})

describe('isEmailShaped', () => {
  it('accepts real addresses', () => {
    expect(isEmailShaped('karinroberts63@gmail.com')).toBe(true)
  })

  it('rejects synthetic/non-email identity strings', () => {
    expect(isEmailShaped('receipt_000152955956')).toBe(false)
    expect(isEmailShaped('crow')).toBe(false)
    expect(isEmailShaped('+12425551234')).toBe(false)
  })
})
