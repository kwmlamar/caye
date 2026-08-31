import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { getGmailContext } from '@/lib/gmail-token'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_SENT = 40
const MAX_INBOX = 40

interface GmailHeader { name: string; value: string }
interface GmailListResponse { messages?: Array<{ id: string }> }
interface GmailMessageDetail {
  id: string
  snippet?: string
  internalDate?: string
  payload?: { headers?: GmailHeader[] }
}

interface DiscoveryMail {
  direction: 'sent' | 'inbox'
  subject: string
  from: string
  to: string
  snippet: string
  sentAt: string | null
}

interface DiscoveryResult {
  business_summary: string
  services: string[]
  active_projects_or_customer_work: string[]
  recurring_workflows: string[]
  vendors_tools_and_systems: string[]
  logistics_and_operations: string[]
  pricing_and_payment_patterns: string[]
  bottlenecks_or_pain_points: string[]
  communication_style: string
  confidence_notes: string[]
}

function header(message: GmailMessageDetail, name: string): string {
  return message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

function obviousNonBusiness(subject: string, snippet: string): boolean {
  const text = `${subject} ${snippet}`
  return /\b(sign[ -]?in code|verification code|one[- ]time pass|otp|password reset|boarding|check-?in information|flight number|netflix|pray logo|your card .* was charged|you sent \$|bank alert|amazon order|eReceipt|rental receipt)\b/i.test(text)
}

async function listMessageIds(accessToken: string, query: string, limit: number): Promise<string[]> {
  const url = `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Gmail list failed (${res.status}) for query: ${query}`)
  const json = await res.json() as GmailListResponse
  return (json.messages || []).map(m => m.id).filter(Boolean)
}

async function fetchMessage(accessToken: string, id: string, direction: DiscoveryMail['direction']): Promise<DiscoveryMail | null> {
  const url = `${GMAIL_API_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const message = await res.json() as GmailMessageDetail
  const subject = header(message, 'Subject') || '(no subject)'
  const snippet = String(message.snippet || '').replace(/\s+/g, ' ').trim()
  if (!snippet || obviousNonBusiness(subject, snippet)) return null
  return {
    direction,
    subject,
    from: header(message, 'From'),
    to: header(message, 'To'),
    snippet: snippet.slice(0, 350),
    sentAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
  }
}

async function fetchDiscoverySample(workspaceId: string): Promise<{ messages: DiscoveryMail[]; accountId: string }> {
  const { accountRow, accessToken } = await getGmailContext(workspaceId)
  const [sentIds, inboxIds] = await Promise.all([
    listMessageIds(accessToken, 'in:sent newer_than:365d', MAX_SENT),
    listMessageIds(accessToken, 'in:inbox newer_than:180d', MAX_INBOX),
  ])

  const work: Array<Promise<DiscoveryMail | null>> = [
    ...sentIds.map(id => fetchMessage(accessToken, id, 'sent')),
    ...inboxIds.map(id => fetchMessage(accessToken, id, 'inbox')),
  ]
  const messages = (await Promise.all(work)).filter((m): m is DiscoveryMail => Boolean(m))
  return { messages, accountId: accountRow.id }
}

async function synthesizeBusinessContext(businessName: string, messages: DiscoveryMail[]): Promise<DiscoveryResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sample = messages.map((m, index) =>
    `[${index + 1}] ${m.direction.toUpperCase()}\nSubject: ${m.subject}\nFrom: ${m.from}\nTo: ${m.to}\nExcerpt: ${m.snippet}`
  ).join('\n\n')

  const prompt = `You are doing a read-only operational discovery pass for "${businessName}" from a sample of the owner's Gmail.

Your job is to understand how the business actually operates. Ignore personal email, travel, banking, authentication/security notices, subscriptions, generic marketing, and anything not clearly connected to the business. Treat every inference as provisional unless directly supported by the email evidence. Do not invent missing details.

<email_sample>\n${sample}\n</email_sample>

Return JSON only with this exact shape:
{
  "business_summary": "2-4 sentence operational summary",
  "services": ["..."],
  "active_projects_or_customer_work": ["..."],
  "recurring_workflows": ["..."],
  "vendors_tools_and_systems": ["..."],
  "logistics_and_operations": ["..."],
  "pricing_and_payment_patterns": ["..."],
  "bottlenecks_or_pain_points": ["..."],
  "communication_style": "...",
  "confidence_notes": ["state uncertainty, sparse evidence, or likely-but-unverified patterns here"]
}`

  const response = await loggedMessagesCreate(anthropic, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }],
  }, { source: 'app/api/caye/gmail-observation-discovery/route.ts:synthesizeBusinessContext' })

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Observation discovery model returned no JSON object')
  return JSON.parse(match[0]) as DiscoveryResult
}

export async function runGmailObservationDiscovery() {
  const supabase = createServiceClient()
  const { data: accounts, error } = await supabase
    .from('connected_accounts')
    .select('id,user_id,channel_account_name,metadata,is_active')
    .eq('channel_type', 'gmail')
    .eq('is_active', true)

  if (error) throw new Error(error.message)

  const candidates = (accounts || []).filter(account => {
    const metadata = (account.metadata || {}) as Record<string, unknown>
    const observeOnly = metadata.observe_only === true || metadata.observe_only === 'true'
    const status = String(metadata.observation_discovery_status || '')
    return observeOnly && status !== 'done' && status !== 'running'
  }).slice(0, 2)

  const results: Array<Record<string, unknown>> = []
  for (const account of candidates) {
    const workspaceId = String(account.user_id)
    const startedAt = new Date().toISOString()
    const existingAccountMeta = (account.metadata || {}) as Record<string, unknown>

    await supabase.from('connected_accounts').update({
      metadata: { ...existingAccountMeta, observation_discovery_status: 'running', observation_discovery_started_at: startedAt },
    }).eq('id', account.id)

    try {
      const { data: workspace } = await supabase
        .from('customers')
        .select('business_name')
        .eq('id', workspaceId)
        .maybeSingle()
      const businessName = String(workspace?.business_name || 'the business')

      const { messages } = await fetchDiscoverySample(workspaceId)
      if (messages.length < 3) {
        throw new Error(`Not enough business-relevant Gmail evidence (${messages.length} messages)`)
      }

      const discovery = await synthesizeBusinessContext(businessName, messages)
      const { data: currentConfig } = await supabase
        .from('workspace_ai_config')
        .select('metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      const configMeta = ((currentConfig?.metadata || {}) as Record<string, unknown>)
      const finishedAt = new Date().toISOString()

      await supabase.from('workspace_ai_config').upsert({
        workspace_id: workspaceId,
        metadata: {
          ...configMeta,
          observation_mode: true,
          gmail_observation_discovery: discovery,
          gmail_observation_discovery_messages_read: messages.length,
          gmail_observation_discovery_finished_at: finishedAt,
        },
        updated_at: finishedAt,
      }, { onConflict: 'workspace_id' })

      await supabase.from('connected_accounts').update({
        metadata: {
          ...existingAccountMeta,
          observe_only: true,
          observation_discovery_status: 'done',
          observation_discovery_messages_read: messages.length,
          observation_discovery_finished_at: finishedAt,
        },
      }).eq('id', account.id)

      results.push({ workspaceId, status: 'done', messagesRead: messages.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown discovery error'
      await supabase.from('connected_accounts').update({
        metadata: {
          ...existingAccountMeta,
          observe_only: true,
          observation_discovery_status: 'failed',
          observation_discovery_error: message.slice(0, 300),
          observation_discovery_finished_at: new Date().toISOString(),
        },
      }).eq('id', account.id)
      console.error('[gmail-observation-discovery] failed', workspaceId, err)
      results.push({ workspaceId, status: 'failed', error: message })
    }
  }

  return { candidates: candidates.length, results }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (secret && provided !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    return NextResponse.json(await runGmailObservationDiscovery())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
