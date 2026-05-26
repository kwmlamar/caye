import { describe, it, expect } from 'vitest'
import { htmlToPlainText } from './email-text'

describe('htmlToPlainText', () => {
  it('strips raw <style> block contents (the Outlook CSS leak)', () => {
    // Real shape of the leak observed in production: an Outlook reply where
    // the <style> block's CSS rules survived tag removal and showed up as
    // garbage text at the top of the message bubble.
    const html = `<html><head><style>
div.zm_1526803674744298471_parse_4423952575885412991 p.MsoNormal,
div.zm_1526803674744298471_parse_4423952575885412991 li.MsoNormal { margin: 0; }
</style></head><body><p>Hi Karenda, please complete the form.</p></body></html>`
    const out = htmlToPlainText(html)
    expect(out).not.toMatch(/MsoNormal/)
    expect(out).not.toMatch(/zm_\d+/)
    expect(out).toContain('Hi Karenda, please complete the form.')
  })

  it('cuts the "On <date>, <name> wrote:" reply chain (Gmail/Apple Mail)', () => {
    const html =
      `<p>Thanks Karenda — sounds great, see you Saturday at 2pm.</p>` +
      `<p>On Mon, May 26, 2026 at 10:14 AM, Karenda &lt;karenda@tourbimini.com&gt; wrote:</p>` +
      `<blockquote>What time works for you?</blockquote>`
    const out = htmlToPlainText(html)
    expect(out).toContain('see you Saturday at 2pm')
    expect(out).not.toMatch(/wrote:/i)
    expect(out).not.toContain('What time works for you?')
  })

  it('cuts the Outlook "-----Original Message-----" marker and everything below', () => {
    const text =
      `Hi Karenda,\n\nPlease see attached.\n\nThanks,\nMartha\n\n` +
      `-----Original Message-----\nFrom: Karenda <karenda@tourbimini.com>\n` +
      `Sent: Monday, May 26, 2026 9:00 AM\nSubject: Re: Booking\n\n` +
      `Hi Martha, here's the info you asked for...`
    const out = htmlToPlainText(text)
    expect(out).toContain('Please see attached')
    expect(out).toContain('Thanks,\nMartha')
    expect(out).not.toMatch(/original message/i)
    expect(out).not.toContain('here\'s the info')
  })

  it('cuts the Outlook forward header (From: + Sent:/Date: within a few lines)', () => {
    // Common in "FW:" forwards — no "Original Message" marker, just a
    // bare From/Sent/To/Subject header block followed by the chain.
    const text =
      `Karenda — forwarding the vendor email below for your review.\n\n` +
      `From: Azamara Vendor Relations <vendors@azamara.com>\n` +
      `Sent: Friday, May 23, 2026 4:15 PM\n` +
      `To: Martha Owen-Vourtsis\n` +
      `Subject: Banking documentation\n\n` +
      `Please resubmit banking info on company letterhead...`
    const out = htmlToPlainText(text)
    expect(out).toContain('forwarding the vendor email')
    expect(out).not.toMatch(/^From:|^Sent:|^Subject:/m)
    expect(out).not.toContain('Please resubmit banking info')
  })

  it('cuts plain-text ">" quoted reply lines', () => {
    const text =
      `Sounds good — confirming for 4 guests at 10am.\n\n` +
      `> On Saturday we have 2 slots open at 10am and 2pm.\n` +
      `> Let me know which works.`
    const out = htmlToPlainText(text)
    expect(out).toContain('confirming for 4 guests')
    expect(out).not.toContain('2 slots open')
  })

  it('passes a clean reply through unchanged (no false-positive cuts)', () => {
    // A clean reply with no quote markers — formality words like "From" or
    // sign-offs like "On the topic of..." must not trigger a quote cut.
    const text =
      `Hi Karenda,\n\nYes, please book us for the Full Bimini Experience on June 3rd. ` +
      `From the website it looks like the 9am slot is open — that works for our group of 4.\n\n` +
      `Looking forward to it!\n\nSarah`
    const out = htmlToPlainText(text)
    expect(out).toContain('Full Bimini Experience on June 3rd')
    expect(out).toContain('group of 4')
    expect(out).toContain('Looking forward to it!')
    expect(out).toContain('Sarah')
  })

  it('handles plain text input with no HTML tags', () => {
    // The callers don't pre-check for HTML — the function must handle both.
    const text = `Just a plain text message.\n\nThanks!`
    expect(htmlToPlainText(text)).toBe('Just a plain text message.\n\nThanks!')
  })
})
