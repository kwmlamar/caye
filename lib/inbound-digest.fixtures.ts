/**
 * Representative inbound shapes for validating the digest extractor.
 *
 * THE DISTINCTION THESE EXIST TO PROVE:
 *   "this email contains business information"  ≠  "the owner must act now"
 *
 * A holding note must not manufacture a decision. A thank-you must not become
 * an escalation. A real deadline must not be flattened into routine. Those
 * three failures are what the 400-character quote path could not even
 * represent, let alone get right.
 *
 * Shared by the unit tests (shape + rendering, no network) and the opt-in
 * live extraction test (lib/inbound-digest.live.test.ts).
 */

export interface DigestFixture {
  id: string
  /** What this case is testing about Caye's judgment. */
  about: string
  body: string
  contactName?: string
  /** What Caye already sent this person on the thread, if anything. */
  alreadySent?: string
  expect: {
    /** Does it carry real business content? */
    substantive: boolean
    /** Does anyone have to DO anything — Caye or the owner? */
    actionNeeded: boolean
    /** True when the owner personally must decide something. */
    decisionExpected: boolean
    /** Fields that must be non-null. */
    required?: string[]
    /** Fields that must be null — inventing them is the failure. */
    forbidden?: string[]
    /** Case-insensitive substrings the intent should capture. */
    intentMentions?: string[]
    /** Substrings that must NOT appear anywhere in the rendered brief. */
    neverRendered?: string[]
  }
}

export const DIGEST_FIXTURES: DigestFixture[] = [
  {
    id: 'ask-at-the-bottom',
    about: 'Long email, request in the final paragraph. Prefix truncation loses it entirely.',
    contactName: 'Ruslan Prakapovich',
    body: `Dear Karenda and Maxwell,

Thank you for this very thoughtful and comprehensive list of questions. I appreciate the care you have taken to document everything clearly, both for our discussion and for your team's reference. These are all excellent questions, and several touch on important operational details that I want to make sure I address thoroughly and accurately.

I have been following your operation for some time and have been consistently impressed by the professionalism your team brings to every departure. Our clients frequently ask about the Bimini area and we have struggled to find a partner we trust.

Could you confirm whether you can accommodate wheelchair users on the sunset cruise, and what your rate would be for groups of 12 or more? We are looking at roughly two departures a month starting in October.

Best regards,
Ruslan Prakapovich
Accessible Travel Solutions`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: true,
      required: ['sender', 'organization', 'requestedAction'],
      intentMentions: ['wheelchair', 'group'],
      neverRendered: ['Thank you for this very thoughtful', 'Dear Karenda'],
    },
  },
  {
    id: 'short-clear-request',
    about: 'Two sentences, obvious ask. Must not be inflated into an essay.',
    contactName: 'Denise Rolle',
    body: `Hi — do you run the sunset tour on Sundays? Looking for 4 people on the 21st.`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: false,
      required: ['requestedAction'],
      forbidden: ['financialImpact'],
      intentMentions: ['sunday'],
    },
  },
  {
    id: 'purely-informational',
    about:
      'Real business information, nothing for the owner to do. THE case that proves substantive and actionNeeded are two questions, not one.',
    contactName: 'Bimini Harbour Authority',
    body: `Notice to operators: the fuel dock at Alice Town will operate on reduced hours during the last week of September for scheduled maintenance. Normal hours resume October 1. No action is required from operators; this notice is for planning purposes only.`,
    expect: {
      // Substantive: reduced fuel-dock hours genuinely affect operations and
      // the owner should know. actionNeeded: nothing to do about it. The one
      // -boolean version forced this into either a decision brief or a
      // "nothing to decide yet, I'll bring it when the real answer lands" —
      // and nothing more is coming, so that promise was a lie.
      substantive: true,
      actionNeeded: false,
      decisionExpected: false,
      forbidden: ['decisionNeeded'],
    },
  },
  {
    id: 'needs-a-decision',
    about: 'A genuine judgment call only the owner can make.',
    contactName: 'Marissa McGourthy',
    body: `We booked the full-day charter for the 14th but my husband's flight was cancelled and we can't make it. We paid the deposit already. Is there any chance of a refund, or could we move it to the following weekend? Whatever you think is fair.`,
    alreadySent: 'Thanks for letting me know — let me check with the team and come back to you.',
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: true,
      required: ['decisionNeeded', 'requestedAction', 'commitmentsMade'],
      intentMentions: ['refund'],
    },
  },
  {
    id: 'hard-deadline',
    about: 'A stated deadline. Must not be flattened into routine.',
    contactName: 'Tavares Bain',
    body: `Morning. We need to confirm the boat for the wedding party by Friday this week or the planner moves to another operator. 18 guests, Saturday the 29th, 2pm departure. Can you hold it?`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: true,
      required: ['deadline', 'requestedAction'],
      intentMentions: ['wedding'],
    },
  },
  {
    id: 'money-on-the-table',
    about: 'Explicit figures. financialImpact must be populated, not guessed elsewhere.',
    contactName: 'Coral Bay Resort',
    body: `Following our call — we'd commit to $2,400 a month for a guaranteed two departures a week through high season, invoiced monthly. That's roughly $14,400 over the six months. Are you able to hold that capacity?`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: true,
      required: ['financialImpact', 'decisionNeeded'],
      intentMentions: ['capacity'],
    },
  },
  {
    id: 'multiple-questions',
    about: 'Several asks. Must consolidate, not enumerate all of them at the owner.',
    contactName: 'Priya Ramnarine',
    body: `A few things before we book:
1. Do you provide snorkel gear or should we bring our own?
2. Is there a toilet on board?
3. What happens if the weather turns — full refund or reschedule?
4. Can you collect us from the Hilton dock rather than the marina?
Thanks!`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: false,
      required: ['requestedAction'],
      forbidden: ['financialImpact'],
    },
  },
  {
    id: 'partnership-proposal',
    about: 'A partnership pitch — a real opportunity, and a real decision.',
    contactName: 'Andre Sweeting',
    body: `I run a small travel agency in Nassau and I place about 40 clients a month into day trips across the islands. I'd like to add Bimini. I'd want a 15% agency commission on anything I send you, standard terms, invoiced monthly. If that works I can start sending bookings from next month.`,
    expect: {
      substantive: true,
      actionNeeded: true,
      decisionExpected: true,
      required: ['decisionNeeded', 'recommendedAction'],
      intentMentions: ['commission'],
    },
  },
  {
    id: 'holding-note-after-our-reply',
    about: 'THE RULE. Caye already replied; this is an acknowledgment, not an ask.',
    contactName: 'Ruslan Prakapovich',
    alreadySent: 'Thanks for reaching out. Let me get this in front of the team and come back to you.',
    body: `Dear Karenda and Maxwell,

Thank you for this very thoughtful and comprehensive list of questions. I appreciate the care you have taken to document everything clearly, both for our discussion and for your team's reference. These are all excellent questions, and several touch on important operational details that I want to make sure I address thoroughly and accurately. Rather than provide partial answers now, I will circle back with a full written response early next week.

Best regards,
Ruslan Prakapovich
Accessible Travel Solutions`,
    expect: {
      substantive: false,
      actionNeeded: false,
      decisionExpected: false,
      // A holding note must not manufacture a decision for the owner.
      forbidden: ['decisionNeeded'],
      neverRendered: ['Thank you for this very thoughtful', 'Dear Karenda'],
    },
  },
  {
    id: 'pure-thanks',
    about: 'THE OTHER RULE. Gratitude must never become an escalation.',
    contactName: 'The Wilsons',
    body: `Just wanted to say thank you — the trip on Saturday was the highlight of our holiday. Captain Max was wonderful with the kids. We'll be recommending you to everyone back home!`,
    expect: {
      substantive: false,
      actionNeeded: false,
      decisionExpected: false,
      forbidden: ['decisionNeeded', 'requestedAction', 'deadline', 'financialImpact'],
    },
  },
]
