import { describe, expect, it } from 'vitest'
import { unsupportedLogisticsTimeClaims } from './logistics-grounding'

const LANEY = `We are taking the 9:00AM ferry from Ft. Lauderdale to Bimini on Sunday, 8/16,
so we'll need transportation beginning around 11:00AM. We will return on the 7:00PM ferry
from Bimini to Ft. Lauderdale on Wednesday, 8/19.`

describe('logistics grounding', () => {
  it('catches the real Laney transformation from transport time to ferry arrival time', () => {
    expect(unsupportedLogisticsTimeClaims('11:00 AM — Ferry arrives', LANEY)).toEqual(['ferry:11:00am'])
  })

  it('allows event/time pairs actually stated in the authoritative thread', () => {
    expect(unsupportedLogisticsTimeClaims('9:00 AM ferry; transportation begins around 11:00 AM. Return on the 7:00 PM ferry.', LANEY)).toEqual([])
  })
})
