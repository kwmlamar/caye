import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parseWhatsAppWebhook,
  classifyInboundOrigin,
  classifyEchoOrigin,
  isAutoReplyEligible,
  normalizeEcho,
  metaTimestampToISO,
  WHATSAPP_ECHO_FIELD,
  WHATSAPP_MESSAGES_FIELD,
} from './coexistence'

const FIXTURES = path.join(__dirname, 'fixtures', 'coexistence')
const BUSINESS_NUMBER = '15550000001'
const CUSTOMER_NUMBER = '15550000042'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))
}

describe('parseWhatsAppWebhook', () => {
  it('parses an ordinary customer inbound change', () => {
    const [change, ...rest] = parseWhatsAppWebhook(fixture('external-inbound-text'))
    expect(rest).toHaveLength(0)
    expect(change.field).toBe(WHATSAPP_MESSAGES_FIELD)
    expect(change.supported).toBe(true)
    expect(change.metadata?.phoneNumberId).toBe('000000000000000')
    expect(change.messages).toHaveLength(1)
    expect(change.echoes).toHaveLength(0)
    expect(change.contacts[0]?.wa_id).toBe(CUSTOMER_NUMBER)
  })

  it('parses a coexistence echo change off the smb_message_echoes field', () => {
    const [change] = parseWhatsAppWebhook(fixture('business-app-echo-text'))
    expect(change.field).toBe(WHATSAPP_ECHO_FIELD)
    expect(change.supported).toBe(true)
    expect(change.echoes).toHaveLength(1)
    expect(change.messages).toHaveLength(0)
  })

  it('reads every entry and change, not just the first', () => {
    // The old entry[0].changes[0] read would have dropped the echo entirely.
    const changes = parseWhatsAppWebhook(fixture('batched-inbound-and-echo'))
    expect(changes.map(c => c.field)).toEqual([WHATSAPP_MESSAGES_FIELD, WHATSAPP_ECHO_FIELD])
    expect(changes[0].messages).toHaveLength(1)
    expect(changes[1].echoes).toHaveLength(1)
  })

  it('keeps delivery/read statuses reachable', () => {
    const [change] = parseWhatsAppWebhook(fixture('delivery-status'))
    expect(change.supported).toBe(true)
    expect(change.messages).toHaveLength(0)
    expect(change.statuses).toEqual([
      expect.objectContaining({ id: 'wamid.TEST_CAYE_SEND_0001', status: 'read' }),
    ])
  })

  it('reports history and smb_app_state_sync as deliberately deferred', () => {
    for (const name of ['history', 'smb-app-state-sync']) {
      const [change] = parseWhatsAppWebhook(fixture(name))
      expect(change.supported).toBe(false)
      expect(change.unsupportedReason).toBe('deferred_coexistence_field')
    }
  })

  it('reports a field Meta has not shipped to us before as unrecognized', () => {
    const [change] = parseWhatsAppWebhook(fixture('unrecognized-field'))
    expect(change.supported).toBe(false)
    expect(change.unsupportedReason).toBe('unrecognized_field')
  })

  it('fails closed when a supported change carries no phone_number_id', () => {
    const [change] = parseWhatsAppWebhook(fixture('messages-missing-metadata'))
    expect(change.supported).toBe(false)
    expect(change.unsupportedReason).toBe('missing_metadata')
    expect(change.messages).toHaveLength(0)
  })

  it('returns nothing rather than throwing on junk', () => {
    expect(parseWhatsAppWebhook(null)).toEqual([])
    expect(parseWhatsAppWebhook({})).toEqual([])
    expect(parseWhatsAppWebhook({ entry: 'nope' })).toEqual([])
    expect(parseWhatsAppWebhook({ entry: [{ changes: [null, 3] }] })).toEqual([])
  })
})

describe('metaTimestampToISO', () => {
  it('converts unix seconds', () => {
    expect(metaTimestampToISO('1756800000')).toBe(new Date(1756800000 * 1000).toISOString())
  })

  it('refuses to invent a time', () => {
    for (const bad of [undefined, null, '', 'later', '0', -1, NaN]) {
      expect(metaTimestampToISO(bad)).toBeNull()
    }
  })
})

describe('origin classification', () => {
  it('treats a message from anyone but the business as an external contact', () => {
    expect(classifyInboundOrigin(CUSTOMER_NUMBER, BUSINESS_NUMBER)).toBe('external_contact')
    expect(classifyInboundOrigin(CUSTOMER_NUMBER, '')).toBe('external_contact')
    expect(classifyInboundOrigin(CUSTOMER_NUMBER, null)).toBe('external_contact')
  })

  it('refuses to claim authorship for a messages-field entry from the business number', () => {
    expect(classifyInboundOrigin(BUSINESS_NUMBER, BUSINESS_NUMBER)).toBe('unknown_business_origin')
  })

  it('attributes an unmatched echo to the human business app, a matched one to Caye', () => {
    expect(classifyEchoOrigin(false)).toBe('business_app_operator')
    expect(classifyEchoOrigin(true)).toBe('caye_cloud_api')
  })
})

describe('isAutoReplyEligible — the anti-loop invariant', () => {
  it('permits only a message from outside the business', () => {
    expect(isAutoReplyEligible('external_contact')).toBe(true)
  })

  it('never permits an automatic reply to observed business-side activity', () => {
    expect(isAutoReplyEligible('business_app_operator')).toBe(false)
    expect(isAutoReplyEligible('caye_cloud_api')).toBe(false)
    expect(isAutoReplyEligible('unknown_business_origin')).toBe(false)
  })
})

describe('normalizeEcho', () => {
  const metadata = { phoneNumberId: '000000000000000', displayPhoneNumber: BUSINESS_NUMBER }

  it('normalizes a text echo and keys the thread on the customer side', () => {
    const [change] = parseWhatsAppWebhook(fixture('business-app-echo-text'))
    const observed = normalizeEcho(change.echoes[0], change.metadata!)
    expect(observed).not.toBeNull()
    expect(observed!.providerMessageId).toBe('wamid.TEST_ECHO_0001')
    // Conversation continuity: the customer's wa_id, never the business's.
    expect(observed!.counterpartyWaId).toBe(CUSTOMER_NUMBER)
    expect(observed!.from).toBe(BUSINESS_NUMBER)
    expect(observed!.observationKind).toBe('message')
    expect(observed!.isText).toBe(true)
    expect(observed!.text).toBe('Cistern is finished, we poured this morning.')
    expect(observed!.provenance).toEqual({
      webhook_field: WHATSAPP_ECHO_FIELD,
      phone_number_id: '000000000000000',
      display_phone_number: BUSINESS_NUMBER,
      provider_type: 'text',
    })
  })

  it('keeps a media descriptor without pretending it is text', () => {
    const [change] = parseWhatsAppWebhook(fixture('business-app-echo-media'))
    const observed = normalizeEcho(change.echoes[0], change.metadata!)!
    expect(observed.messageType).toBe('image')
    expect(observed.isText).toBe(false)
    expect(observed.text).toBeNull()
    expect(observed.provenance.provider_type).toBe('image')
  })

  it('normalizes an edit against the message it amends', () => {
    const [change] = parseWhatsAppWebhook(fixture('business-app-echo-edit'))
    const observed = normalizeEcho(change.echoes[0], change.metadata!)!
    expect(observed.observationKind).toBe('edit')
    expect(observed.referencedMessageId).toBe('wamid.TEST_ECHO_0001')
    expect(observed.text).toBe('Cistern is finished, we poured yesterday.')
  })

  it('normalizes a revoke without a body', () => {
    const [change] = parseWhatsAppWebhook(fixture('business-app-echo-revoke'))
    const observed = normalizeEcho(change.echoes[0], change.metadata!)!
    expect(observed.observationKind).toBe('revoke')
    expect(observed.referencedMessageId).toBe('wamid.TEST_ECHO_0001')
    expect(observed.text).toBeNull()
  })

  it('drops an echo missing the identity fields every write depends on', () => {
    expect(normalizeEcho({ to: CUSTOMER_NUMBER, timestamp: '1756800000', type: 'text' }, metadata)).toBeNull()
    expect(normalizeEcho({ id: 'x', timestamp: '1756800000', type: 'text' }, metadata)).toBeNull()
    expect(normalizeEcho({ id: 'x', to: CUSTOMER_NUMBER, type: 'text' }, metadata)).toBeNull()
    expect(normalizeEcho({ id: 'x', to: CUSTOMER_NUMBER, timestamp: '1756800000' }, metadata)).toBeNull()
    // edit/revoke without the id they amend are unusable, not "a text message"
    expect(normalizeEcho({ id: 'x', to: CUSTOMER_NUMBER, timestamp: '1756800000', type: 'revoke' }, metadata)).toBeNull()
    expect(normalizeEcho({ id: 'x', to: CUSTOMER_NUMBER, timestamp: '1756800000', type: 'edit' }, metadata)).toBeNull()
  })
})

describe('transport layer stays domain-neutral', () => {
  // Acceptance criterion 8. The transport/normalization layer must not learn
  // any one customer's vocabulary; that belongs to the business-understanding
  // layer downstream, behind confirmation.
  // Word-bounded, so an innocent 'methods' never trips the 'ods' check.
  const FORBIDDEN = ['ods', 'bedrock', 'tropitrack', 'cistern', 'freight', 'dock receipt', 'wallace']
  const SOURCES = [
    path.join(__dirname, 'coexistence.ts'),
    path.join(__dirname, 'coexistence-ingest.ts'),
  ]

  it('contains no customer-specific keyword or project logic', () => {
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8').toLowerCase()
      for (const term of FORBIDDEN) {
        const pattern = new RegExp(`\\b${term.replace(/ /g, '\\s+')}\\b`)
        expect(pattern.test(source), `${path.basename(file)} must not mention "${term}"`).toBe(false)
      }
    }
  })
})
