/**
 * catch-up-welcome.ts
 *
 * The first-day-on-the-job moment: Caye reads the last N days of inbound
 * messages, classifies what mattered, and reports back to the owner.
 *
 * Modelled on the Lindy.ai onboarding catch-up. Surfaces:
 *   - what shape the inbox is in (volume, channel mix)
 *   - what Caye handled herself
 *   - what's still waiting on the owner (held / unread inquiries)
 *
 * Caye speaks AS HERSELF here (competent receptionist talking to her boss),
 * not in the owner's voice. The voice profile is used elsewhere — when
 * Caye replies to CUSTOMERS as the owner. Here she's reporting in.
 */

import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from './supabase-server'
import { classifyInbound, type InboundCategory } from './inbound-classifier'
import { loggedMessagesCreate } from './llm-telemetry'

export interface CatchUpBullet {
  conversationId: string
  customerName: string
  channel: string
  preview: string
  category: InboundCategory | null
  status: 'held' | 'unread_inquiry' | 'unread' | 'ai_handled' | 'open'
  lastMessageAt: string
}

export interface CatchUpStats {
  totalThreads: number
  customerMessages: number
  held: number
  unread: number
  aiHandled: number
  byChannel: Record<string, number>
}

export interface CatchUpResult {
  text: string
  bullets: CatchUpBullet[]
  windowDays: number
  stats: CatchUpStats
  generatedAt: string
}

const DEFAULT_DAYS = 5
const MAX_BULLETS = 8
// Cap how many conversations we inspect closely. Beyond this, threads
// only count toward stats — we don't pull message bodies. Keeps token
// cost bounded for noisy inboxes.
const MAX_CONVOS_INSPECTED = 40

interface ConvoRow {
  id: string
  customer_name: string | null
  channel_type: string
  last_message_at: string
  last_message_preview: string | null
  status: string | null
  human_agent_enabled: boolean | null
  human_agent_reason: string | null
  unread_count: number | null
  connected_account_id: string
}

interface MessageRow {
  conversation_id: string
  sender_type: string
  content: string | null
  sent_at: string
}

/**
 * Priority for "what needs the owner's attention." Higher = more urgent
 * in the catch-up summary. Tie-broken by recency.
 */
function attentionPriority(b: CatchUpBullet): number {
  switch (b.status) {
    case 'held': return 100
    case 'unread_inquiry': return 80
    case 'unread': return 60
    case 'open': return 20
    case 'ai_handled': return 10
  }
}

export async function generateCatchUp(
  workspaceId: string,
  daysInput: number = DEFAULT_DAYS
): Promise<CatchUpResult> {
  const days = Math.max(1, Math.min(30, Math.floor(daysInput)))
  const supabase = createServiceClient()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  // 1. Workspace + connected accounts
  const [{ data: customer }, { data: accounts }] = await Promise.all([
    supabase
      .from('customers')
      .select('business_name, full_name')
      .eq('id', workspaceId)
      .maybeSingle(),
    supabase
      .from('connected_accounts')
      .select('id, channel_type')
      .eq('user_id', workspaceId)
      .eq('is_active', true),
  ])

  const accountIds = (accounts || []).map(a => a.id)
  const businessName = customer?.business_name || 'your business'
  const ownerFirstName = pickFirstName(customer?.full_name)

  // Empty case: no accounts connected → return a clear "I can't see anything yet" message
  if (accountIds.length === 0) {
    return {
      text:
        "I'm not connected to any inboxes yet. Once you connect an email or messaging account, " +
        "I'll go through the last few days and tell you what's been happening.",
      bullets: [],
      windowDays: days,
      stats: { totalThreads: 0, customerMessages: 0, held: 0, unread: 0, aiHandled: 0, byChannel: {} },
      generatedAt: new Date().toISOString(),
    }
  }

  // 2. Conversations with activity in the window
  const { data: convoRows, error: convoErr } = await supabase
    .from('unified_conversations')
    .select(
      'id, customer_name, channel_type, last_message_at, last_message_preview, ' +
      'status, human_agent_enabled, human_agent_reason, unread_count, connected_account_id'
    )
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .gte('last_message_at', since)
    .order('last_message_at', { ascending: false })
    .limit(MAX_CONVOS_INSPECTED)

  if (convoErr) {
    throw new Error(`catch-up: failed to load conversations: ${convoErr.message}`)
  }
  const convos = (convoRows || []) as unknown as ConvoRow[]

  // 3. Latest customer message per conversation (for classification + preview)
  const latestCustomerByConvo = new Map<string, MessageRow>()
  if (convos.length > 0) {
    const convoIds = convos.map(c => c.id)
    const { data: msgRows } = await supabase
      .from('unified_messages')
      .select('conversation_id, sender_type, content, sent_at')
      .in('conversation_id', convoIds)
      .eq('sender_type', 'customer')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })

    for (const row of (msgRows || []) as MessageRow[]) {
      if (!latestCustomerByConvo.has(row.conversation_id)) {
        latestCustomerByConvo.set(row.conversation_id, row)
      }
    }
  }

  // 4. Counts of AI-handled messages in window (sender_type='ai')
  let aiHandledCount = 0
  let customerMsgCount = 0
  if (convos.length > 0) {
    const convoIds = convos.map(c => c.id)
    const [{ count: aiCount }, { count: custCount }] = await Promise.all([
      supabase
        .from('unified_messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', convoIds)
        .eq('sender_type', 'ai')
        .gte('sent_at', since),
      supabase
        .from('unified_messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', convoIds)
        .eq('sender_type', 'customer')
        .gte('sent_at', since),
    ])
    aiHandledCount = aiCount || 0
    customerMsgCount = custCount || 0
  }

  // 5. Build bullets — one per conversation, classified + statused
  const byChannel: Record<string, number> = {}
  const bullets: CatchUpBullet[] = []
  let heldCount = 0
  let unreadCount = 0

  for (const c of convos) {
    byChannel[c.channel_type] = (byChannel[c.channel_type] || 0) + 1

    const latest = latestCustomerByConvo.get(c.id)
    const preview = (latest?.content || c.last_message_preview || '').trim().slice(0, 240)
    const { category } = latest?.content
      ? classifyInbound(latest.content, '')
      : { category: null as InboundCategory | null }

    const isHeld = c.human_agent_enabled === true
    const isUnread = (c.unread_count || 0) > 0
    if (isHeld) heldCount++
    if (isUnread) unreadCount++

    let status: CatchUpBullet['status']
    if (isHeld) status = 'held'
    else if (isUnread && (category === 'booking_inquiry' || category === 'complaint')) status = 'unread_inquiry'
    else if (isUnread) status = 'unread'
    else status = 'open'

    bullets.push({
      conversationId: c.id,
      customerName: (c.customer_name || 'Unknown customer').trim(),
      channel: c.channel_type,
      preview,
      category,
      status,
      lastMessageAt: c.last_message_at,
    })
  }

  // 6. Sort by attention priority, then by recency. Trim to MAX_BULLETS.
  bullets.sort((a, b) => {
    const dp = attentionPriority(b) - attentionPriority(a)
    if (dp !== 0) return dp
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  })
  const topBullets = bullets.slice(0, MAX_BULLETS)

  const stats: CatchUpStats = {
    totalThreads: convos.length,
    customerMessages: customerMsgCount,
    held: heldCount,
    unread: unreadCount,
    aiHandled: aiHandledCount,
    byChannel,
  }

  // 7. Narrative from Claude — Caye reporting in to the owner
  const narrative = await composeNarrative({
    businessName,
    ownerFirstName,
    days,
    stats,
    bullets: topBullets,
  })

  // 8. Append a formatted bullet list under the narrative so the chat UI
  //    can render the whole catch-up as a single Caye message. parseCayeMessageText
  //    handles markdown-style lists natively.
  const text = topBullets.length > 0
    ? `${narrative}\n\n**Top of your list:**\n${renderBulletsAsMarkdown(topBullets)}`
    : narrative

  return {
    text,
    bullets: topBullets,
    windowDays: days,
    stats,
    generatedAt: new Date().toISOString(),
  }
}

function pickFirstName(fullName: string | null | undefined): string | undefined {
  if (!fullName) return undefined
  const first = fullName.trim().split(/\s+/)[0]
  return first || undefined
}

function statusLabel(s: CatchUpBullet['status']): string {
  switch (s) {
    case 'held': return 'waiting on you'
    case 'unread_inquiry': return 'unread inquiry'
    case 'unread': return 'unread'
    case 'ai_handled': return 'I replied'
    case 'open': return 'open'
  }
}

function renderBulletsAsMarkdown(bullets: CatchUpBullet[]): string {
  return bullets.map(b => {
    const preview = b.preview ? ` — "${b.preview.slice(0, 140)}${b.preview.length > 140 ? '…' : ''}"` : ''
    return `- **${b.customerName}** (${channelLabel(b.channel)}, ${statusLabel(b.status)})${preview}`
  }).join('\n')
}

function channelLabel(ch: string): string {
  switch (ch) {
    case 'email': return 'email'
    case 'gmail': return 'Gmail'
    case 'whatsapp': return 'WhatsApp'
    case 'instagram': return 'Instagram'
    case 'messenger': return 'Messenger'
    default: return ch
  }
}

interface NarrativeInput {
  businessName: string
  ownerFirstName?: string
  days: number
  stats: CatchUpStats
  bullets: CatchUpBullet[]
}

async function composeNarrative(input: NarrativeInput): Promise<string> {
  const { businessName, ownerFirstName, days, stats, bullets } = input

  // Empty inbox case — short canned response, no LLM needed
  if (stats.totalThreads === 0) {
    const opener = ownerFirstName ? `Hi ${ownerFirstName} — ` : ''
    return (
      `${opener}I went through the last ${days} days and didn't find any customer activity yet. ` +
      `As soon as messages start coming in I'll handle what I can and flag what needs you.`
    )
  }

  const channelBreakdown = Object.entries(stats.byChannel)
    .map(([ch, n]) => `${n} ${channelLabel(ch)}`)
    .join(', ')

  const bulletLines = bullets.map(b => {
    const status =
      b.status === 'held' ? 'WAITING ON YOU' :
      b.status === 'unread_inquiry' ? 'UNREAD INQUIRY' :
      b.status === 'unread' ? 'UNREAD' :
      b.status === 'ai_handled' ? 'I HANDLED THIS' :
      'OPEN'
    const cat = b.category ? ` [${b.category}]` : ''
    return `- ${b.customerName} (${channelLabel(b.channel)})${cat} — ${status}: "${b.preview.slice(0, 160)}"`
  }).join('\n')

  const systemPrompt = `You are Caye, an AI receptionist reporting in to your boss${ownerFirstName ? ` (${ownerFirstName})` : ''} for the first time. You just read the last ${days} days of their inbox at ${businessName} and are telling them what you found.

You speak AS YOURSELF (a competent receptionist briefing the owner), not in the owner's voice.

STRICT RULES:
- No emoji of any kind.
- No tropical / island / beach imagery or metaphors. No "island time," "paradise," "set sail," "smooth sailing." Do not perform a Caribbean accent or persona.
- Plain text. Neutral, warm, slightly professional — a sharp assistant briefing their boss.
- Keep it short: 2–3 short paragraphs. The owner will scan, not read.
- Lead with what NEEDS their attention. End with what you've already handled or a "tell me where to start" closer.
- Do not pad. Do not say "I'm excited to" or "Looking forward to." Skip greetings if they feel performative — opening with the actual report is fine.
- Refer to the business by name when natural; never invent a name.
- Don't repeat the bullet list — that's rendered separately under your message. Your job is the narrative + judgment.`

  const userPrompt =
    `Window: last ${days} days.\n\n` +
    `STATS:\n` +
    `- ${stats.totalThreads} active customer threads (${channelBreakdown || 'no channel breakdown'})\n` +
    `- ${stats.customerMessages} inbound customer messages\n` +
    `- ${stats.held} held for your review\n` +
    `- ${stats.unread} unread\n` +
    `- ${stats.aiHandled} messages I replied to myself\n\n` +
    `TOP ITEMS (sorted by attention needed):\n${bulletLines || '(none)'}\n\n` +
    `Write your briefing.`

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await loggedMessagesCreate(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { source: 'lib/catch-up-welcome.ts:generateBriefingNarrative' })
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim()
    if (text) return text
  } catch (err) {
    console.error('[catch-up-welcome] LLM narrative failed:', err)
  }

  // Fallback: deterministic narrative without the LLM. Safe and shippable
  // even if the API call fails or is rate-limited.
  const opener = ownerFirstName ? `Hi ${ownerFirstName}.` : 'Quick briefing.'
  const parts: string[] = [opener]
  parts.push(
    `Over the last ${days} days I've seen ${stats.totalThreads} customer thread${stats.totalThreads === 1 ? '' : 's'} ` +
    `across ${channelBreakdown || 'your channels'}, with ${stats.customerMessages} inbound message${stats.customerMessages === 1 ? '' : 's'} total.`
  )
  if (stats.held > 0 || stats.unread > 0) {
    parts.push(
      `${stats.held > 0 ? `${stats.held} held for your call. ` : ''}` +
      `${stats.unread > 0 ? `${stats.unread} unread.` : ''}`.trim()
    )
  }
  if (stats.aiHandled > 0) {
    parts.push(`I replied to ${stats.aiHandled} message${stats.aiHandled === 1 ? '' : 's'} myself.`)
  }
  parts.push('Tell me where you want to start.')
  return parts.join(' ')
}
