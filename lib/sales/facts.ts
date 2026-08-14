/**
 * facts.ts
 *
 * What Caye is allowed to assert about Caye.
 *
 * WHY (2026-08-12)
 * Price, proof point and capabilities previously existed only as prose
 * inside a system prompt ("Price is $79/mo flat... Bimini Island Tours and
 * Karenda are the standing proof point"). Prose in a prompt is a
 * suggestion: it cannot be checked after generation, and the 2026-08-01
 * incident (7 of 31 drafts shipped phrases the same prompt explicitly
 * banned) is the standing evidence that this model ignores its own
 * instructions at volume.
 *
 * So the facts live here as data, get rendered INTO the prompt, and are the
 * list `claims.ts` checks the finished draft against. One source, used
 * twice, in both directions.
 *
 * Keeping this in code rather than the `business_facts` table is
 * deliberate: these are product truths that change with a deploy (and want
 * review), not per-workspace operational knowledge an owner teaches Caye in
 * chat. `business_facts` remains the right home for the latter and is now
 * also read on this workspace.
 */

export interface SalesFacts {
  /** Monthly price in USD. The only number Caye may quote. */
  monthlyPriceUsd: number
  /** Businesses Caye may name as customers. Empty is legitimate. */
  nameableCustomers: readonly string[]
  /** Named people Caye may reference. */
  nameablePeople: readonly string[]
  /** Channels the product genuinely handles today. */
  supportedChannels: readonly string[]
  /** Things prospects ask for that do NOT exist. Naming them here lets Caye
   *  say "no, not yet" accurately instead of guessing either way. */
  notBuilt: readonly string[]
  /** The one CTA. */
  demoUrl: string
  siteUrl: string
  /** Product positioning is reviewed product knowledge, not customer proof. */
  approvedPositioning: readonly string[]
}

/**
 * Current truth, 2026-08-12. Sources: STATE.md (1 paying customer, Bimini
 * at $79/mo from 2026-07-01), the WhatsApp personal-number blocker
 * (decisions-log 2026-08-06 — guest-facing WhatsApp cannot be connected for
 * an owner whose business line is their personal phone), and the fact that
 * no integration surface beyond email/WhatsApp/Instagram/Messenger exists.
 */
export const SALES_FACTS: SalesFacts = {
  monthlyPriceUsd: 79,
  nameableCustomers: ['Bimini Island Tours'],
  nameablePeople: ['Karenda'],
  supportedChannels: ['WhatsApp', 'email', 'Instagram', 'Messenger'],
  notBuilt: [
    'phone/voice answering',
    'SMS',
    'QuickBooks or accounting integration',
    'payment processing beyond a sent payment link',
    'multi-location or franchise management',
    'a mobile app',
    'staff scheduling or payroll',
  ],
  demoUrl: 'https://www.meetcaye.com',
  siteUrl: 'https://www.meetcaye.com',
  approvedPositioning: [
    'Caye helps owner-operated businesses keep customer conversations moving across approved channels.',
    'She can answer routine customer questions, follow up, surface exceptions, and support booking/operations where the workspace has the required setup.',
    'She finds a bounded piece of useful work and performs it only when the required authority, commercial prerequisites, and access are in place.',
    'She escalates instead of inventing facts, making commitments, or acting outside approved authority.',
  ],
}

/** Rendered into every sales generation prompt, so instruction and
 *  post-generation check are built from the same object. */
export function renderFactsBlock(f: SalesFacts = SALES_FACTS): string {
  const customers = f.nameableCustomers.length
    ? f.nameableCustomers.join(', ')
    : '(none you may name)'
  return [
    'VERIFIED FACTS. These are the only product claims you may make. Anything not here, you do not know.',
    `- Price: $${f.monthlyPriceUsd}/month flat. No other number is real. No discounts, tiers, trials-with-card, or annual deals exist.`,
    `- Customers you may name: ${customers}. Never imply more customers than this.`,
    `- Channels that genuinely work today: ${f.supportedChannels.join(', ')}.`,
    `- Does NOT exist yet, say so plainly if asked: ${f.notBuilt.join('; ')}.`,
    `- Approved product positioning: ${f.approvedPositioning.join(' ')}`,
    '- If asked something not covered here, say you will check and get back to them. Never fill the gap yourself.',
  ].join('\n')
}
