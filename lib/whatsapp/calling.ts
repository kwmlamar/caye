import 'server-only'

/**
 * WhatsApp calling boundary.
 *
 * The webhook/signaling surface and the live audio bridge are deliberately
 * separated from Caye's authority layer. A future Meta call adapter can feed
 * audio into OpenAI Realtime, but any business action must still delegate to
 * Caye's canonical capability gateway with the authenticated workspace/actor.
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

/**
 * Fail closed until a real Meta calling transport is configured. This keeps
 * "WhatsApp calls" from appearing enabled merely because voice-note audio
 * exists. Stateless Vercel webhook handling is not itself a live media bridge.
 */
export function whatsappCallingConfigured(): boolean {
  return process.env.WHATSAPP_CALLING_ENABLED === 'true' && !!process.env.WHATSAPP_CALLING_BRIDGE_URL
}
