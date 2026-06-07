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

  it('cuts the Zoho Mail "---- On <date> <name> wrote ----" format', () => {
    // Zoho threads replies with dashes around the "On ... wrote" header
    // instead of the Gmail-style colon. Real example pulled from Omayra
    // Calzada's web3forms booking reply on 2026-05-31.
    const text =
      `Hi Omayra,\n\nThank you for reaching out — Sunday is open.\n\n` +
      `Karenda\nBimini Island Tours  ---- On Sun, 31 May 2026 18:12:59 ` +
      `-0400 Bimini Island Tours Booking Form ` +
      `<notify+szx9mp@web3forms.com> wrote ----\n\n` +
      `Form Submission Data from your website.\nName\nOmayra Calzada\n` +
      `Email\nomarytorres@yahoo.com`
    const out = htmlToPlainText(text)
    expect(out).toContain('Thank you for reaching out')
    expect(out).toContain('Karenda')
    expect(out).not.toMatch(/wrote\s*-+/i)
    expect(out).not.toContain('Form Submission Data')
    expect(out).not.toContain('omarytorres@yahoo.com')
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

  it('strips orphan CSS rules at the top of the body (Marissa McGourthy case)', () => {
    // Real shape of the leak observed in production: Outlook CSS rules
    // arrived without surrounding <style> tags, so stripHtmlBlockContents
    // couldn't catch them. ~10 lines of CSS preceded the actual message.
    const leaked = [
      'div.zm_6506737843841804039_parse_965487511404414116 p.MsoNormal, div.zm_6506737843841804039_parse_965487511404414116 li.MsoNormal, div.zm_6506737843841804039_parse_965487511404414116 div.MsoNormal { margin: 0in; font-size: 12pt; font-family: "Aptos", sans-serif }',
      'div.zm_6506737843841804039_parse_965487511404414116 a:link, div.zm_6506737843841804039_parse_965487511404414116 span.x_1023950312MsoHyperlink { color: blue; text-decoration: underline }',
      'div.zm_6506737843841804039_parse_965487511404414116 span.x_1023950312size { }',
      'div.zm_6506737843841804039_parse_965487511404414116 .x_1023950312MsoChpDefault { font-size: 10pt }',
      '',
      'Hi there,',
      '',
      'One more question on your pricing for the Golf Cart tour. You state "starting at $350" but I\'m curious how that number fluctuates? Is it a per person additional charge?',
      '',
      'Thanks again,',
      'Marissa',
    ].join('\n')
    const out = htmlToPlainText(leaked)
    expect(out.startsWith('Hi there,')).toBe(true)
    expect(out).not.toContain('MsoNormal')
    expect(out).not.toContain('font-family')
    expect(out).toContain('how that number fluctuates')
    expect(out).toContain('Marissa')
  })

  it('does NOT strip legitimate text that happens to contain braces', () => {
    // Customer might write "we paid {amount}" or "the {tour} is great".
    // Curly braces in regular text should not trigger the CSS stripper.
    const text = 'Hi! I am interested in {Heritage Tour} for 4 people. Thanks!'
    const out = htmlToPlainText(text)
    expect(out).toContain('Heritage Tour')
    expect(out).toContain('4 people')
  })

  it('preserves the message when CSS-like text appears mid-body, not at top', () => {
    // The stripper should only operate on a CSS block at the very top.
    // Once real prose begins, it stops scanning.
    const text = [
      'Hi there,',
      '',
      'Just letting you know our team uses div.foo { margin: 0 } for our website.',
      '',
      'Thanks!',
    ].join('\n')
    const out = htmlToPlainText(text)
    expect(out).toContain('Hi there,')
    expect(out).toContain('div.foo { margin: 0 }')
    expect(out).toContain('Thanks!')
  })
})
