import { describe, it, expect } from 'vitest'
import { decideImageBurst, IMAGE_BURST_WINDOW_MS } from './image-burst'

const now = new Date('2026-08-09T19:41:20Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('decideImageBurst', () => {
  it('answers the first image', () => {
    expect(
      decideImageBurst({ previousImageAt: null, now, hasCaption: false }).respond
    ).toBe(true)
  })

  // Mrs. Max's eleven photos landed 1-7s apart and drew eleven replies.
  it('stays quiet on images arriving seconds apart', () => {
    expect(
      decideImageBurst({ previousImageAt: ago(4_000), now, hasCaption: false }).respond
    ).toBe(false)
  })

  it('stays quiet right up to the window edge', () => {
    expect(
      decideImageBurst({
        previousImageAt: ago(IMAGE_BURST_WINDOW_MS - 1),
        now,
        hasCaption: false,
      }).respond
    ).toBe(false)
  })

  it('answers again once the burst has clearly ended', () => {
    expect(
      decideImageBurst({
        previousImageAt: ago(IMAGE_BURST_WINDOW_MS + 1),
        now,
        hasCaption: false,
      }).respond
    ).toBe(true)
  })

  // A caption is the operator actually asking for something.
  it('always answers a captioned image, even mid-burst', () => {
    expect(
      decideImageBurst({ previousImageAt: ago(2_000), now, hasCaption: true }).respond
    ).toBe(true)
  })

  it('explains itself for the logs', () => {
    expect(
      decideImageBurst({ previousImageAt: ago(3_000), now, hasCaption: false }).reason
    ).toContain('continuing burst')
  })
})
