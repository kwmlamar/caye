---
status: idea, not started
created: 2026-08-02
trigger: revisit at 10 paying customers (same milestone as the $79-flat re-pricing review, 2026-07-28 decision — reused rather than picking a fresh number since Lamar wasn't sure)
---

# Caye — Voice Calling Roadmap

Came up as a "can you imagine" riff (2026-08-02): guests or owners calling Caye and talking to her over an actual WhatsApp voice call, not just text. This captures the frame so it survives until the milestone hits and there's room to build it properly.

## What this actually is

WhatsApp shipped a Business Calling API — this isn't hypothetical infrastructure, Meta supports businesses receiving/making voice calls through WhatsApp. The gap is entirely on Caye's side: everything that exists today is turn-based text (inbound message → full tool loop → reply). A live call needs a different runtime, not a config flip.

## Why this is a real build, not an extension

- **Streaming, not turn-based.** Current architecture waits for a complete inbound message, runs the full tool loop, sends a complete reply. A call needs low-latency speech-to-text in and TTS out while she's still "thinking," or the caller sits in dead air.
- **Barge-in/interruption handling.** If a guest cuts her off mid-sentence to correct something, that's a different interaction model than a chat thread with discrete messages.
- **The high-risk confirmation gate assumes a pause between turns.** `gateHighRisk` (lib/caye-agent/tools/high-risk-gate.ts) stages an action and waits for a genuinely new inbound message to confirm it — that mechanism leans on the natural gap between WhatsApp texts. A live call has no equivalent boundary to hang that on; needs its own design, not a reuse.
- **Separate Meta approval.** Calling access is gated behind its own review, distinct from the WhatsApp Business messaging approval Caye already has.

## Which surface first

**Front desk, not back office.** A guest calling to book a tour is a much more natural voice moment than an owner calling to check revenue over the phone — owners already have WhatsApp text + the Admin Shell/dashboard for that. If this gets built, front desk is the obvious first target, not back office.

## What needs to be true before starting

- [ ] **10 paying customers** (reused pricing-review milestone — proxy for "the core text product is proven enough to justify a genuinely new runtime")
- [ ] Someone has actually scoped the streaming STT/TTS pipeline choice (build vs. a voice-agent platform) — not evaluated at all yet
- [ ] A design for how the high-risk confirmation gate (or an equivalent) works inside a live call, since the current stage-and-wait-for-a-new-message mechanism doesn't map directly
- [ ] Meta's Business Calling API approval process understood/started

## What to do next time this file gets opened

1. Confirm customer count against the 10-customer trigger
2. Decide build vs. buy on the real-time voice pipeline
3. Design the high-risk-gate equivalent for a live-call context
4. Start the Meta calling-API approval process in parallel (per the pattern used for driver-dispatch templates, 2026-07-05 decision — submit early, code readiness and approval are decoupled)
