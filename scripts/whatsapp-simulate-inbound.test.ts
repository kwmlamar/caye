import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildInboundPayload, signBody, checkTargetAllowed } from './whatsapp-simulate-inbound.mjs'

// This suite tests the exported pure functions only. It deliberately does
// NOT start a server, make a network request, or import
// app/api/webhooks/whatsapp-operator/route.ts (that file is `server-only`
// and would fail to import here). Instead it recomputes the route's own
// signature scheme independently and asserts the two match, and it walks
// the payload through the same property-access path processInbound() uses.

describe('buildInboundPayload', () => {
  it('produces a payload that parses through the same access path processInbound() uses', () => {
    const payload = buildInboundPayload({
      text: 'hey caye',
      from: '+15551234567',
      name: 'Jordan Owner',
      phoneNumberId: '111111111111111',
      wabaId: '222222222222222',
    }) as Record<string, unknown>

    // Mirror processInbound()'s exact access chain.
    const entry = (payload.entry as Record<string, unknown>[])[0]
    const change = (entry.changes as Record<string, unknown>[])[0]
    const value = change.value as {
      metadata?: { phone_number_id?: string }
      messages?: Array<{ id: string; from: string; timestamp: string; type: string; text?: { body: string } }>
      contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
    }

    expect(entry.id).toBe('222222222222222')
    expect(value.metadata?.phone_number_id).toBe('111111111111111')

    const message = value.messages?.[0]
    expect(message).toBeDefined()
    expect(message?.from).toBe('15551234567') // Meta strips the leading "+"
    expect(message?.type).toBe('text')
    expect(message?.text?.body).toBe('hey caye')
    expect(typeof message?.id).toBe('string')
    expect(message?.id.length).toBeGreaterThan(0)
    expect(typeof message?.timestamp).toBe('string')
  })

  it('matches the contact wa_id to the message from so the profile-name lookup resolves', () => {
    // processInbound() does:
    //   value.contacts?.find(c => normalizeE164(c.wa_id) === normalizeE164(message.from))
    // A simplified normalizeE164 for this assertion: strip non-digits.
    const normalize = (s: string) => s.replace(/\D/g, '')

    const payload = buildInboundPayload({
      text: 'hi',
      from: '+15559998888',
      name: 'Alex Staff',
    }) as any

    const value = payload.entry[0].changes[0].value
    const message = value.messages[0]
    const contact = value.contacts.find((c: { wa_id?: string }) => normalize(c.wa_id ?? '') === normalize(message.from))

    expect(contact).toBeDefined()
    expect(contact.profile.name).toBe('Alex Staff')
    expect(normalize(contact.wa_id)).toBe(normalize(message.from))
  })

  it('requires --text and --from', () => {
    expect(() => buildInboundPayload({ text: '', from: '+1' })).toThrow()
    expect(() => buildInboundPayload({ text: 'hi', from: '' })).toThrow()
  })
})

describe('signBody', () => {
  it('exactly matches the route\'s own verifySignature scheme', () => {
    const secret = 'test-secret-value'
    const rawBody = JSON.stringify({ hello: 'world' })

    // Recompute independently, the same way route.ts's verifySignature() does:
    //   const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

    const actual = signBody(rawBody, secret)
    expect(actual).toBe(expected)

    // Also assert against a fixed known vector, so the scheme itself
    // (algorithm, encoding, prefix) is pinned and can't silently drift.
    const fixedBody = '{"a":1}'
    const fixedSecret = 'shhh'
    const fixedExpected = 'sha256=' + createHmac('sha256', fixedSecret).update(fixedBody).digest('hex')
    expect(signBody(fixedBody, fixedSecret)).toBe(fixedExpected)
  })

  it('returns null when no secret is provided (mirrors the route skipping verification)', () => {
    expect(signBody('{}', undefined)).toBeNull()
    expect(signBody('{}', '')).toBeNull()
  })
})

describe('checkTargetAllowed (safety guard)', () => {
  it('allows localhost and 127.0.0.1 without --allow-remote', () => {
    expect(checkTargetAllowed('http://localhost:3000/api/webhooks/whatsapp-operator').allowed).toBe(true)
    expect(checkTargetAllowed('http://127.0.0.1:3000/api/webhooks/whatsapp-operator').allowed).toBe(true)
  })

  it('rejects a remote host without --allow-remote', () => {
    const result = checkTargetAllowed('https://staging.example.com/api/webhooks/whatsapp-operator')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/allow-remote/i)
  })

  it('allows a remote non-production host when allowRemote is true', () => {
    const result = checkTargetAllowed('https://staging.example.com/api/webhooks/whatsapp-operator', {
      allowRemote: true,
    })
    expect(result.allowed).toBe(true)
  })

  it('rejects a production host (meetcaye.com) even with --allow-remote', () => {
    const result = checkTargetAllowed('https://meetcaye.com/api/webhooks/whatsapp-operator', {
      allowRemote: true,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/production/i)
  })

  it('rejects a production host (getcaye.com) even with --allow-remote', () => {
    const result = checkTargetAllowed('https://www.getcaye.com/api/webhooks/whatsapp-operator', {
      allowRemote: true,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/production/i)
  })

  it('rejects a production host without --allow-remote too', () => {
    const result = checkTargetAllowed('https://meetcaye.com/api/webhooks/whatsapp-operator')
    expect(result.allowed).toBe(false)
  })
})
