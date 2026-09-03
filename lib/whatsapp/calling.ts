import 'server-only'

/**
 * WhatsApp calling boundary.
 *
 * Signaling/live media remain separate from Caye's authority layer. A future
 * Meta/Twilio call adapter can feed audio into OpenAI Realtime, but business
 * actions still delegate to Caye's canonical capability gateway with an
 * authenticated workspace/actor identity.
 */
export interface WhatsAppCallIdentity {
  workspaceId: string
  actorKind: 'founder' | 'operator' | 'customer'
  actorId?: string | null
  waId: string
}

export interface WhatsAppCallSession {
  callId: string
  identity: WhatsAppCallIdentity
  state: 'ringing' | 'connecting' | 'active' | 'ended' | 'failed'
  startedAt: string
  endedAt?: string | null
}

export interface WhatsAppCallMediaBridge {
  accept(session: WhatsAppCallSession): Promise<void>
  end(callId: string): Promise<void>
}

/** Fail closed until a real calling transport/media bridge is configured. */
export function whatsappCallingConfigured(): boolean {
  return (
    process.env.WHATSAPP_CALLING_ENABLED === 'true' &&
    !!process.env.WHATSAPP_CALLING_BRIDGE_URL
  )
}
