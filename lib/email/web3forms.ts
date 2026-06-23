/**
 * Web3Forms submission parser.
 *
 * Karenda's website contact form forwards through web3forms, which sends
 * the submission to her Zoho inbox from `notify+<formId>@web3forms.com`
 * with the real customer's name + email + phone buried in the body as
 * labeled form fields. Caye must resolve the actual customer identity
 * (Anthony Coll / emtsocal@gmail.com) rather than treating the form
 * service as the "customer" — otherwise replies go to the wrong address
 * and every submission dedups into one mega-thread.
 *
 * Extracted from app/api/email/poll/route.ts (2026-06-23) so the
 * zoho-email webhook can apply the same identity resolution as the
 * cron poll. See receptionist-spec.md follow-up grilling 2026-06-23.
 */

export interface Web3FormsParsed {
  customerName: string
  customerEmail: string
  /** All fields from the submission, in source order, using the form's own labels. */
  fields: Array<{ label: string; value: string }>
}

// Caye is a general receptionist — these are the only two fields the rest of
// the system semantically needs (to identify the customer). Everything else
// is rendered with whatever label the form actually uses.
const NAME_ALIASES = ['name', 'your name', 'full name', 'customer name', 'first name']
const EMAIL_ALIASES = ['email', 'email address', 'your email', 'customer email']

// Boilerplate text Web3Forms wraps around the field list — used to find the
// fields section in the email body.
const FIELDS_START_RE = /details below\.?\s*$/im
const FIELDS_END_RE = /(visitor ip\b|report spam|powered by web3forms|don'?t want these emails)/i

/**
 * Returns true if this email is a Web3Forms submission notification
 * rather than a direct email from a customer.
 */
export function isWeb3FormsNotification(fromEmail: string): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase() || ''
  return domain === 'web3forms.com' || domain === 'web3forms.co'
}

/**
 * Parses a Web3Forms submission email into a generic ordered list of
 * label/value pairs. Doesn't assume any vertical (tour/SaaS/etc.) —
 * uses whatever labels the form's own fields have.
 */
export function parseWeb3FormsFields(body: string): Web3FormsParsed | null {
  // Narrow to the fields section (between the "Details below." marker and the footer)
  const startMatch = body.match(FIELDS_START_RE)
  const startIdx = startMatch ? startMatch.index! + startMatch[0].length : 0
  const tail = body.slice(startIdx)
  const endMatch = tail.match(FIELDS_END_RE)
  const fieldsBlock = (endMatch ? tail.slice(0, endMatch.index) : tail).trim()
  if (!fieldsBlock) return null

  // Web3Forms layouts:
  //   A: label and value alternate as blocks separated by blank lines
  //      ("Name\n\nLamar Sineus\n\nBusiness name\n\ntropitech")
  //   B: each block has "label\nvalue" on consecutive non-blank lines
  //   C: legacy "Label: value" on one line
  const fields: Array<{ label: string; value: string }> = []
  const blocks = fieldsBlock.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean)

  // Try Layout A: alternating label/value blocks
  if (blocks.length >= 2 && blocks.length % 2 === 0) {
    let ok = true
    const tentative: typeof fields = []
    for (let i = 0; i < blocks.length; i += 2) {
      const label = blocks[i].split('\n')[0].trim()
      const value = blocks[i + 1].split('\n').map(l => l.trim()).filter(Boolean).join(' ')
      if (!label || !value || label.length > 60) { ok = false; break }
      if (value.toLowerCase() === 'none') continue
      tentative.push({ label, value })
    }
    if (ok) fields.push(...tentative)
  }

  // Fallback Layout B: "label\nvalue" inside a single block, or Layout C inline
  if (fields.length === 0) {
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 0) continue
      // Inline "Label: value"
      const inline = lines[0].match(/^([^:]{1,60}):\s*(.+)$/)
      if (inline) {
        const value = [inline[2], ...lines.slice(1)].join(' ').trim()
        if (value && value.toLowerCase() !== 'none') {
          fields.push({ label: inline[1].trim(), value })
        }
        continue
      }
      // Stacked "label\nvalue"
      if (lines.length >= 2) {
        const label = lines[0]
        const value = lines.slice(1).join(' ')
        if (label.length <= 60 && value && value.toLowerCase() !== 'none') {
          fields.push({ label, value })
        }
      }
    }
  }

  if (fields.length === 0) return null

  // Extract identity fields by alias (only Name + Email are semantically needed)
  const findByAlias = (aliases: string[]): string | null => {
    for (const f of fields) {
      if (aliases.includes(f.label.toLowerCase())) return f.value
    }
    return null
  }
  const customerName = findByAlias(NAME_ALIASES)
  const customerEmail = findByAlias(EMAIL_ALIASES)
  if (!customerName || !customerEmail) return null

  return {
    customerName,
    customerEmail: customerEmail.toLowerCase(),
    fields,
  }
}

/**
 * Renders the parsed submission as plain "Label: value" lines using the
 * form's own field labels — no vertical-specific renaming. Used as the
 * canonical "body" for the inbound message so downstream (Caye's reply
 * generation) sees structured customer data instead of web3forms
 * boilerplate.
 */
export function buildWeb3FormsContext(parsed: Web3FormsParsed): string {
  return parsed.fields.map(f => `${f.label}: ${f.value}`).join('\n')
}
