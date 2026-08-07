import { describe, it, expect } from 'vitest'
import { corroborateItemRef, type ItemRefCandidate } from './item-ref-guard'

// The real held queue at the time of the 2026-08-07 incident, in order.
const PENDING: ItemRefCandidate[] = [
  'Oceans Africa',
  'Eternal Andamans',
  'BlueFinn Charters',
  'Anda De Wata Tours',
  'FRS Portugal',
  'Alt Travel',
  'Ocean Friendly Tours',
  'Cancun and Riviera Maya',
  'Kim',
  'Emotion Tour Peru',
  'Susana',
  'Karma Boat Cruises',
  'Juliana',
  'Manuel Antonio Catamaran',
  'Makena Coast Charters',
  'Kay Tours Mexico',
  'Capt. Raquel Crummitt',
  'Fernando',
  'contact@hunter.io',
].map((contactName, i) => ({ index: i + 1, contactName }))

const DISAMBIGUATION_LIST =
  'Which one? ' + PENDING.map((p) => `${p.index}. ${p.contactName}`).join(' / ')

describe('corroborateItemRef — drops refs the operator never gave', () => {
  it('drops the invented "1" behind the Oceans Africa misfire', () => {
    // Lamar typed "Yes" to confirm a send staged for Zanzibar Holidays One.
    // The classifier returned item_ref "1" — Oceans Africa, an unrelated lead.
    const { itemRef, reason } = corroborateItemRef({
      itemRef: '1',
      operatorText: 'Yes',
      lastOutboundBody:
        "Here's what'll go out:\n\n---\n\nHey,\n\nJust checking in — did you get a chance " +
        'to try the demo at meetcaye.com?\n\nTakes about 5 minutes, no card or signup.\n\n' +
        'Lamar\nTropiTech Solutions\n\n---\n\nSend that?',
      pending: PENDING,
    })
    expect(itemRef).toBeUndefined()
    expect(reason).toMatch(/Oceans Africa/)
  })

  it("does not let Caye's own numbered list corroborate anything", () => {
    // The disambiguation list names every contact and every index, so it must
    // corroborate nothing — otherwise it rubber-stamps whatever the model picks.
    for (const ref of ['1', '7', 'Fernando']) {
      const { itemRef } = corroborateItemRef({
        itemRef: ref,
        operatorText: 'yes',
        lastOutboundBody: DISAMBIGUATION_LIST,
        pending: PENDING,
      })
      expect(itemRef).toBeUndefined()
    }
  })

  it('drops a ref pointing at nothing the operator typed', () => {
    const { itemRef, reason } = corroborateItemRef({
      itemRef: 'Eternal Andamans',
      operatorText: 'yeah go ahead',
      lastOutboundBody: DISAMBIGUATION_LIST,
      pending: PENDING,
    })
    expect(itemRef).toBeUndefined()
    expect(reason).toMatch(/not corroborated/)
  })

  it('keeps a name the operator typed that is NOT in the queue', () => {
    // Interop guard with lib/whatsapp/item-ref-resolution.ts (commit 30ff58c).
    // Karenda wrote "Lisa is completed" and Lisa was not a held item. That
    // module exists to answer "Lisa isn't in the held queue" instead of
    // re-listing — which only works if the ref reaches it. Dropping it here
    // because it matches nothing pending would collapse it back to "which
    // one?" and silently undo that fix.
    const { itemRef, reason } = corroborateItemRef({
      itemRef: 'Lisa Ramos',
      operatorText: 'Lisa is completed',
      lastOutboundBody: null,
      pending: PENDING,
    })
    expect(itemRef).toBe('Lisa Ramos')
    expect(reason).toBeNull()
  })

  it('still drops an unmatched ref the operator never typed', () => {
    const { itemRef, reason } = corroborateItemRef({
      itemRef: 'Zanzibar Holidays One',
      operatorText: 'Yes',
      lastOutboundBody: DISAMBIGUATION_LIST,
      pending: PENDING,
    })
    expect(itemRef).toBeUndefined()
    expect(reason).toMatch(/matches no pending item/)
  })
})

describe('corroborateItemRef — keeps refs the operator did give', () => {
  it('keeps a number the operator typed', () => {
    expect(
      corroborateItemRef({
        itemRef: '3',
        operatorText: 'send 3',
        lastOutboundBody: DISAMBIGUATION_LIST,
        pending: PENDING,
      }).itemRef
    ).toBe('3')
  })

  it('keeps a name the operator typed', () => {
    expect(
      corroborateItemRef({
        itemRef: 'Fernando',
        operatorText: 'skip Fernando',
        lastOutboundBody: null,
        pending: PENDING,
      }).itemRef
    ).toBe('Fernando')
  })

  it('does not mistake a substring of a bigger number for an index', () => {
    // "$100" must not corroborate item 1 / 10 / 0.
    const { itemRef } = corroborateItemRef({
      itemRef: '1',
      operatorText: 'tell them $100',
      lastOutboundBody: null,
      pending: PENDING,
    })
    expect(itemRef).toBeUndefined()
  })

  it('keeps a bare "yes please" after a single-contact ping', () => {
    // Regression guard for the Karenda 2026-08-07 fix: a yes/no ping about ONE
    // held item must still resolve without the operator naming them again.
    expect(
      corroborateItemRef({
        itemRef: '9',
        operatorText: 'yes please',
        lastOutboundBody: 'Kim came in — needs your call. Want me to take a first pass?',
        pending: PENDING,
      }).itemRef
    ).toBe('9')
  })

  it('passes through when there is nothing to confuse', () => {
    const single = [PENDING[0]]
    expect(
      corroborateItemRef({
        itemRef: '1',
        operatorText: 'yes',
        lastOutboundBody: null,
        pending: single,
      }).itemRef
    ).toBe('1')
    expect(
      corroborateItemRef({
        itemRef: undefined,
        operatorText: 'yes',
        lastOutboundBody: null,
        pending: PENDING,
      }).itemRef
    ).toBeUndefined()
  })
})
