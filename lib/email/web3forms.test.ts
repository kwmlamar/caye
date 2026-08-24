import { describe, expect, it } from 'vitest'
import { parseWeb3FormsFields } from './web3forms'

describe('parseWeb3FormsFields', () => {
  it('parses Zoho webhook compact-table notifications into the submitting customer', () => {
    const parsed = parseWeb3FormsFields(`Form Submission Data from your website.
Name
Maya Rolle
Email
maya@example.com
Phone
242-555-0100
Guests
2
Date
Saturday, August 29, 2026
Tour
Bimini Day Trip
Notes
Please reserve two seats.
Visitor IP: 203.0.113.7
Powered by Web3Forms`)

    expect(parsed).toMatchObject({
      customerName: 'Maya Rolle',
      customerEmail: 'maya@example.com',
    })
    expect(parsed?.fields).toEqual(expect.arrayContaining([
        { label: 'Name', value: 'Maya Rolle' },
        { label: 'Email', value: 'maya@example.com' },
        { label: 'Guests', value: '2' },
      ]))
  })
})
