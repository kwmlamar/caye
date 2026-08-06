import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { buildConnectUrl } from './connect-token'
import type { ConnectChannel } from './channel-types'
import {
  getChannelState,
  slotForChannelType,
  SLOT_LABEL,
  SLOT_ORDER,
  type ChannelIntake,
  type ChannelSlot,
  type ChannelState,
} from './slots'

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * Drives the connect walkthrough forward from the OAuth callback.
 *
 * The walkthrough advances on *connection events*, not on the
 * conversation — the owner taps a link, finishes OAuth in the browser,
 * and by the time they close the tab Caye's next message is already
 * waiting in WhatsApp. That removes the "go back to the app and wait"
 * dead air that kills these flows on a phone.
 *
 * Fired fire-and-forget from the callbacks: a slow or failed WhatsApp
 * send must never delay or break the OAuth redirect the user is sitting in.
 */

/** Which OAuth initiator a still-missing slot should be offered through. */
function connectChannelForSlot(slot: ChannelSlot, intake: ChannelIntake | null): ConnectChannel | null {
  if (slot === 'inbox') {
    if (intake?.emailProvider === 'google') return 'gmail'
    if (intake?.emailProvider === 'zoho') return 'zoho'
    return null // can't tell — Caye asks instead of guessing
  }
  return slot
}

function firstConnectionLine(slotLabel: string, businessName: string | null): string {
  const who = businessName ? ` for ${businessName}` : ''
  // The celebration lives here rather than at the end of the discovery
  // interview: this is the first moment "I'm live" is actually true.
  return `That's it — your ${slotLabel} is connected and I'm watching it now${who}. 🎉`
}

/**
 * What Caye should do next once a connection lands. Offering a link is
 * only right when we already know the channel applies to them — otherwise
 * she has to ask first, because a link for a channel they don't use (or
 * can't safely connect) is worse than a question.
 */
export type NextAction =
  | { kind: 'offer'; label: string; url: string }
  | { kind: 'ask_whatsapp_line' }
  | { kind: 'ask_social' }
  | { kind: 'done'; whatsappOnPersonalPhone: boolean }

/**
 * Composes the message that follows a successful connection. Exported for
 * testing; callers use announceConnection.
 */
export function composeProgressMessage(args: {
  justConnected: ChannelSlot
  isFirstConnection: boolean
  businessName: string | null
  next: NextAction
}): string {
  const label = SLOT_LABEL[args.justConnected]
  const head = args.isFirstConnection
    ? firstConnectionLine(label, args.businessName)
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} is connected. ✅`

  switch (args.next.kind) {
    case 'offer':
      return `${head}\n\nNext: ${args.next.label}. Tap here and I'll catch those too — ${args.next.url}`

    case 'ask_whatsapp_line':
      // Never hand over an Embedded Signup link before this is answered —
      // connecting migrates the number and kills WhatsApp on their phone.
      return (
        `${head}\n\n` +
        'WhatsApp next. Quick one first: is the number guests message you on a separate ' +
        'business line, or the same phone you use yourself?'
      )

    case 'ask_social':
      return `${head}\n\nDo guests message you on Instagram or Facebook too?`

    case 'done':
      return args.next.whatsappOnPersonalPhone
        ? `${head}\n\n` +
          "That's everything I can pick up for you. WhatsApp stays on your own phone exactly " +
          'as it is — you keep using it normally, and you still reach me right here anytime.'
        : `${head}\n\nThat's everything connected. I'll take it from here — message me anytime.`
  }
}

/**
 * Picks the single next step. Order follows SLOT_ORDER, but a channel we
 * can't yet offer safely turns into a question rather than being skipped —
 * skipping silently is how WhatsApp sat unasked for four months.
 */
export function decideNextAction(
  workspaceId: string,
  state: ChannelState,
  intake: ChannelIntake | null
): NextAction {
  // Walk SLOT_ORDER rather than state.missing: a gated slot is absent from
  // missing, so iterating that would silently step over WhatsApp and land
  // on Instagram — losing the priority order and, worse, never asking the
  // WhatsApp question at all. That silent step-over is exactly the shape
  // of the four-month Bimini stall.
  for (const candidate of SLOT_ORDER) {
    if (state.connected.includes(candidate)) continue

    const gate = state.gated.find((g) => g.slot === candidate)
    if (gate) {
      // 'unknown_line' is a question owed, not a decision made. Any other
      // reason is a settled no — move past it.
      if (candidate === 'whatsapp' && gate.reason === 'unknown_line') {
        return { kind: 'ask_whatsapp_line' }
      }
      continue
    }

    // Social we've never asked about: ask once rather than firing a link
    // for a channel they may not even have.
    if (
      (candidate === 'instagram' || candidate === 'messenger') &&
      intake?.inventory?.[candidate] === undefined
    ) {
      return { kind: 'ask_social' }
    }

    const channel = connectChannelForSlot(candidate, intake)
    if (!channel) continue // e.g. inbox with an undetected email host

    return {
      kind: 'offer',
      label: SLOT_LABEL[candidate],
      url: buildConnectUrl(workspaceId, channel, { source: 'wa' }),
    }
  }

  return {
    kind: 'done',
    whatsappOnPersonalPhone: state.gated.some(
      (g) => g.slot === 'whatsapp' && g.reason === 'personal_phone'
    ),
  }
}

/**
 * Tells the owner a channel just connected and offers the next one.
 *
 * No-ops when the workspace has no channel_intake row: those predate the
 * walkthrough entirely (they're existing customers who already settled
 * their setup), and messaging them about a channel they deliberately
 * skipped months ago would be worse than saying nothing.
 */
export async function announceConnection(
  supabase: SupabaseClient,
  workspaceId: string,
  connectedChannelType: string
): Promise<void> {
  try {
    const slot = slotForChannelType(connectedChannelType)
    if (!slot) return

    const { data: config } = await supabase
      .from('workspace_ai_config')
      .select('channel_intake')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    const intake = (config?.channel_intake as ChannelIntake | null) ?? null
    if (intake == null) return // grandfathered — never initiate

    const { data: owner } = await supabase
      .from('operator_allowlist')
      .select('phone')
      .eq('workspace_id', workspaceId)
      .eq('role', 'owner')
      .not('verified_at', 'is', null)
      .limit(1)
      .maybeSingle()

    if (!owner?.phone) return

    const state = await getChannelState(supabase, workspaceId)
    const { data: customer } = await supabase
      .from('customers')
      .select('business_name')
      .eq('id', workspaceId)
      .maybeSingle()

    // The slot that just landed is already reflected in state.connected,
    // so "first connection" means nothing else is live alongside it.
    const isFirstConnection = state.connected.length <= 1

    const message = composeProgressMessage({
      justConnected: slot,
      isFirstConnection,
      businessName: customer?.business_name ?? null,
      next: decideNextAction(workspaceId, state, intake),
    })

    const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
    const result = await sendFreeFormWhatsApp(
      owner.phone,
      message,
      // Idempotent per workspace+channel: a double callback (user hits
      // back, provider retries) must not send the message twice.
      `connect-progress-${workspaceId}-${connectedChannelType}`
    )
    if (result.status === 'failed') {
      console.error(`[connect-progress] send failed for workspace=${workspaceId}:`, result.error)
    }
  } catch (err) {
    console.error(`[connect-progress] threw for workspace=${workspaceId}:`, err)
  }
}
