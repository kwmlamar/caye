# WhatsApp voice notes rollout

1. Customer webhook: transcribe inbound audio, preserve media metadata, route transcript through the existing customer agent, and answer in voice when synthesis/send succeeds. Text fallback must reuse the same authorized reply.
2. Operator/founder webhook: resolve platform identity first, transcribe with the platform token, and feed the transcript into the existing operator/founder text path exactly once.
3. Calling: keep disabled until a real signaling/media bridge is configured and tested against the active Meta sender. Business actions during calls must delegate through Caye's capability/authority layer.
4. Device verification: confirm Meta renders the outbound audio as the intended WhatsApp voice experience and verify transcription for actual WhatsApp Opus media.

Failure invariants: never hallucinate a failed transcript, never execute the agent twice because audio rendering failed, never expand authority because the input arrived as audio, and never report calling as enabled without a live media bridge.
