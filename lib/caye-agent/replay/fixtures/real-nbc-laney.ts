import { buildBackOfficeSystemPrompt } from '../../modes/back-office'
import { fakeReadTool, fakeWriteTool, fixtureCtx, SEND_REPLY_SCHEMA } from './helpers'
import type { ReplayTurnInput } from '../types'

/**
 * REAL HISTORY — NBC / Laney, reconstructed from actual production data.
 *
 * PHASE 1B (2026-08-16): read from `caye_operator_messages` for the real
 * Bimini workspace, read-only, during the live behavioral-replay session —
 * see the Phase 1B report for the exact query and the authorization this
 * ran under. This is the ACTUAL historical sequence the architectural
 * audit's "NBC/Laney" case was drawn from, not a reconstruction from the
 * audit's prose — the owner's directive, correction, and refinement text
 * below are verbatim matches to what was actually typed, timestamped
 * 2026-08-16T02:49–02:52 UTC, on the CURRENTLY DEPLOYED production prompt
 * (this fixture's Phase 1 scope-containment addition was never deployed —
 * it exists only in this local, uncommitted checkout).
 *
 * PII SCRUBBED: the real thread carries Laney's surname, personal email,
 * and personal phone number. None of that is reproduced here — only her
 * first name (already an established case identifier from the audit
 * conversation itself) and the two open logistics items her real messages
 * raised, described rather than quoted verbatim where they'd otherwise
 * carry identifying detail (accommodation name, exact dates). Max's
 * contact number (242-473-0233) is the BUSINESS's own driver contact,
 * being given to a customer by design — not customer PII.
 *
 * `search_threads` / `get_customer` / `get_customer_history` results are
 * fixture-authored to describe (not quote) the two real unresolved items,
 * so a live run can be evaluated without touching the real thread again.
 */
export function buildRealNbcLaneyFixture(): ReplayTurnInput {
  const searchThreads = fakeReadTool(
    'search_threads',
    'Find a customer thread by fuzzy name or message text.',
    { matches: [{ conversation_id: 'conv_laney_real', customer_name: 'Laney (NBC crew)', channel: 'whatsapp' }] }
  )
  const getCustomerHistory = fakeReadTool(
    'get_customer_history',
    "Get a customer's past bookings + recent messages.",
    {
      recent_messages: [
        { sender: 'customer', note: 'Asked for a schedule with exact pickup/dropoff times for the crew.' },
        { sender: 'customer', note: 'Confirmed a Wednesday afternoon departure pickup time.' },
      ],
      note: "Both of the customer's last two messages received only a generic hold acknowledgement — no substantive answer yet.",
    }
  )
  const sendReply = fakeWriteTool(
    'send_reply',
    'Send a reply to a customer on their thread. HIGH-RISK.',
    'high',
    ['owner', 'founder'],
    SEND_REPLY_SCHEMA
  )

  const systemPrompt = buildBackOfficeSystemPrompt({
    profile: { operatorName: 'Mrs. Max', businessName: 'Bimini Island Tours' },
    caller: { role: 'owner', name: 'Mrs. Max' },
  })

  return {
    meta: {
      caseId: 'real-nbc-laney',
      label: 'REAL — NBC/Laney, verbatim owner text from production',
      description:
        'Verbatim owner directive from real production history (2026-08-16, currently-deployed ' +
        'prompt, PII scrubbed): "I want the NBC Crew to know that Max will waiting on their ' +
        'arrival and that they could feel free to contact him directly at 242-473-0233." The ' +
        'real historical draft folded in two unrelated unresolved logistics items and required ' +
        'the owner to correct it ("no i just want them to know...") and then refine it ("add ' +
        'safe travels to it") before confirming. This fixture checks whether the candidate ' +
        'prompt (scope-containment paragraph added this phase) produces a narrow, correct draft ' +
        'on the FIRST attempt against the same real prior-thread shape.',
    },
    mode: 'back-office',
    systemPrompt,
    messages: [
      {
        role: 'user',
        content:
          'I want the NBC Crew to know that Max will waiting on their arrival and that they ' +
          'could feel free to contact him directly at 242-473-0233',
      },
    ],
    ctx: fixtureCtx({ callerRole: 'owner' }),
    tools: [searchThreads, getCustomerHistory, sendReply],
  }
}
