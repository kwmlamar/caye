import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * A *logical* channel — the thing the operator actually thinks they have
 * ("my inbox", "my Instagram"), as opposed to the provider-specific
 * `connected_accounts.channel_type` rows underneath it.
 *
 * The distinction is load-bearing. Zoho writes channel_type='email' and
 * Gmail writes channel_type='gmail' (see app/api/auth/gmail/callback),
 * so a naive "does this workspace have gmail?" check reports *false* for
 * a workspace whose Zoho inbox has been working for months — and Caye
 * would then message a paying, fully-activated customer asking them to
 * connect an inbox they already have. Bimini is exactly that shape.
 * Always ask about slots, never about channel_type.
 */
export type ChannelSlot = 'inbox' | 'whatsapp' | 'instagram' | 'messenger'

const TYPE_TO_SLOT: Record<string, ChannelSlot> = {
  email: 'inbox', // Zoho Mail
  gmail: 'inbox', // Gmail / Google Workspace
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'messenger',
}

/**
 * Offer order. Inbox first is deliberate: it's the only slot a new owner
 * can reliably finish on the first try (one OAuth redirect, no Meta
 * Business account, no migration), and a completed connection gives Caye
 * real traffic to point at when she asks for the next one. WhatsApp is
 * the most valuable but the least completable, so it goes second.
 */
export const SLOT_ORDER: ChannelSlot[] = ['inbox', 'whatsapp', 'instagram', 'messenger']

export const SLOT_LABEL: Record<ChannelSlot, string> = {
  inbox: 'email',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
}

export function slotForChannelType(channelType: string): ChannelSlot | null {
  return TYPE_TO_SLOT[channelType] ?? null
}

/**
 * How the guest-facing WhatsApp number is set up, as answered by the
 * owner. Gates the Embedded Signup offer — see whatsAppAvailability.
 */
export type WhatsAppLine = 'business' | 'personal' | 'landline'

export interface ChannelIntake {
  /** Which optional channels the owner said guests actually use. */
  inventory?: Partial<Record<'instagram' | 'messenger' | 'whatsapp', boolean>>
  /** Detected from the owner's email domain (MX), not asked. */
  emailProvider?: 'google' | 'zoho' | 'microsoft' | 'other' | null
  whatsappLine?: WhatsAppLine | null
  /** Tools they named that Caye has no connector for — roadmap signal. */
  unsupportedTools?: string[]
}

export type WhatsAppAvailability =
  | { available: true }
  | { available: false; reason: 'personal_phone' | 'not_used' | 'unknown_line' }

/**
 * Whether we may offer WhatsApp Embedded Signup at all.
 *
 * Connecting a number to the Cloud API *migrates* it, and the WhatsApp
 * app then stops working on that handset. For an owner whose business
 * phone is their own phone that is destructive and irreversible, so this
 * gate is a hard precondition, not a hint: never render or send an
 * Embedded Signup link without an explicit 'business' or 'landline'
 * answer. Confirmed 2026-08-06 as the real cause of Bimini's four-month
 * stall. Landlines are fine — they register by voice verification and
 * nobody runs the app on them.
 */
export function whatsAppAvailability(intake: ChannelIntake | null): WhatsAppAvailability {
  if (intake?.inventory?.whatsapp === false) return { available: false, reason: 'not_used' }
  const line = intake?.whatsappLine
  if (line === 'business' || line === 'landline') return { available: true }
  if (line === 'personal') return { available: false, reason: 'personal_phone' }
  return { available: false, reason: 'unknown_line' }
}

export interface ChannelState {
  connected: ChannelSlot[]
  /** Offerable and not yet connected, in SLOT_ORDER. */
  missing: ChannelSlot[]
  /** Withheld on purpose, with the reason — never silently dropped. */
  gated: { slot: ChannelSlot; reason: string }[]
  next: ChannelSlot | null
  /** True once at least one slot is live — i.e. Caye is actually working. */
  isLive: boolean
}

/**
 * Derives where a workspace is in the connect walkthrough. Deliberately
 * *derived* rather than stored: no step pointer to go stale while someone
 * ignores Caye for nine days and then connects something from the
 * dashboard. Recomputed on demand, always correct, idempotent.
 */
export function deriveChannelState(
  connectedTypes: string[],
  intake: ChannelIntake | null
): ChannelState {
  const connected = SLOT_ORDER.filter((slot) =>
    connectedTypes.some((t) => slotForChannelType(t) === slot)
  )

  const missing: ChannelSlot[] = []
  const gated: ChannelState['gated'] = []

  for (const slot of SLOT_ORDER) {
    if (connected.includes(slot)) continue

    if (slot === 'whatsapp') {
      const wa = whatsAppAvailability(intake)
      if (!wa.available) {
        gated.push({ slot, reason: wa.reason })
        continue
      }
    } else if (slot === 'instagram' || slot === 'messenger') {
      // Only offer social they told us guests actually use. Undefined
      // means we haven't asked yet — offer it; false means they said no.
      if (intake?.inventory?.[slot] === false) {
        gated.push({ slot, reason: 'not_used' })
        continue
      }
    }

    missing.push(slot)
  }

  return { connected, missing, gated, next: missing[0] ?? null, isLive: connected.length > 0 }
}

export async function getChannelState(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<ChannelState> {
  const [{ data: accounts }, { data: config }] = await Promise.all([
    supabase
      .from('connected_accounts')
      .select('channel_type')
      .eq('user_id', workspaceId)
      .eq('is_active', true),
    supabase
      .from('workspace_ai_config')
      .select('channel_intake')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ])

  const types = (accounts ?? []).map((a: { channel_type: string }) => a.channel_type)
  return deriveChannelState(types, (config?.channel_intake as ChannelIntake | null) ?? null)
}
