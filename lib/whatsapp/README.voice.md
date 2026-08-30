# WhatsApp voice surface

Voice notes are treated as another transport into Caye, not as a separate agent.

Inbound audio should be downloaded and transcribed, then routed through the same customer or operator pipeline that already owns identity, workspace scope, approvals, escalation, holds, memory, and side effects. The transcript is semantic input; the original media identity should remain in message metadata for auditability.

Outbound voice should render an already-authorized Caye text reply to audio. If synthesis/upload fails, the caller should fall back to the original text reply rather than re-running the agent.

Calling remains disabled unless a real signaling/media bridge is configured. A future bridge may connect WhatsApp call media to OpenAI Realtime, but Realtime must delegate business actions back to Caye's canonical capability gateway.
