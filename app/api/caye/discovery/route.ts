/**
 * POST /api/caye/discovery
 *
 * Background discovery job triggered after Zoho OAuth completes.
 * Reads the owner's last 30 sent messages, asks Claude to extract
 * business knowledge (services, pricing, hours, tone), and persists
 * the results to workspace_ai_config.
 *
 * Also inserts Caye's first greeting message into the owner's active
 * thread with a summary of what was found.
 *
 * Auth: Bearer token (owner JWT) OR internal x-discovery-secret header
 * Body: { workspaceId: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshZohoToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }).toString(),
  })
  const data = await res.json()
  if (!data.access_token) return null
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

/**
 * Fetch recent sent messages from the owner's Zoho account.
 * Returns a flat list of { subject, snippet } objects.
 */
async function fetchSentMessages(
  base: string,
  accountId: string,
  accessToken: string,
  limit = 30
): Promise<Array<{ subject: string; snippet: string }>> {
  try {
    // Find the Sent folder
    const foldersRes = await fetch(`${base}/api/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    })
    const foldersData = await foldersRes.json().catch(() => null)
    const folders: Array<{ folderId?: string; id?: string; folderType?: string; folderName?: string }> =
      Array.isArray(foldersData?.data) ? foldersData.data : []

    const sentFolder = folders.find(f => {
      const type = String(f.folderType || '').toLowerCase()
      const name = String(f.folderName || '').toLowerCase()
      return type === 'sent' || name === 'sent'
    })
    const sentFolderId = String(sentFolder?.folderId || sentFolder?.id || '')

    if (!sentFolderId) {
      console.warn('[discovery] Could not locate Sent folder')
      return []
    }

    // List messages in the Sent folder
    const msgsRes = await fetch(
      `${base}/api/accounts/${accountId}/folders/${sentFolderId}/messages?limit=${limit}&sortBy=date&sortOrder=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
    )
    const msgsData = await msgsRes.json().catch(() => null)
    const messages: Array<Record<string, unknown>> = Array.isArray(msgsData?.data)
      ? msgsData.data
      : []

    // Collect subjects + summaries (skip newsletter-like messages)
    const results: Array<{ subject: string; snippet: string }> = []
    for (const msg of messages.slice(0, limit)) {
      const subject = String(msg.subject || '(no subject)')

      // Skip obvious newsletter / mass-mailer subjects
      if (/unsubscribe|newsletter|digest|weekly update|marketing|promotion/i.test(subject)) {
        continue
      }

      // Use the summary field if available — avoids a second fetch per message
      const summary = String(msg.summary || msg.snippet || msg.excerpt || '').trim()
      if (summary) {
        results.push({ subject, snippet: summary.slice(0, 300) })
      }
    }

    return results
  } catch (err) {
    console.error('[discovery] fetchSentMessages failed:', err)
    return []
  }
}

/**
 * Build the conversational intake fallback message when the inbox is empty.
 * This is inserted as Caye's first message to prompt the owner to describe
 * their business.
 */
function buildConversationalIntakeMessage(firstName: string): string {
  const name = firstName || 'there'
  return `Hi ${name}! I just connected to your inbox — it looks like you're just getting started or there isn't much sent mail to read yet.\n\nTo help me understand your business, can you tell me:\n\n- What services or tours do you offer?\n- What are your typical prices?\n- What hours do you usually operate?\n\nOnce I know, I'll handle your inbox like a pro.`
}

/**
 * Uses Claude to extract structured business knowledge from sent-mail snippets.
 * Returns a concise freetext block for workspace_ai_config.system_prompt.
 */
async function extractBusinessKnowledge(
  businessName: string,
  sentMessages: Array<{ subject: string; snippet: string }>
): Promise<{
  systemPromptAddition: string
  pricingInfo: string
  summary: string
} | null> {
  if (!sentMessages.length) return null

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const snippetBlock = sentMessages
    .slice(0, 20)
    .map((m, i) => `[${i + 1}] Subject: ${m.subject}\nExcerpt: ${m.snippet}`)
    .join('\n\n')

  const prompt = `You are reading a sample of sent emails from the owner of "${businessName}". Your job is to extract any factual business knowledge present in the messages.

<sent_emails>
${snippetBlock}
</sent_emails>

Extract the following, only including what is actually mentioned. Do not invent or guess:

1. SERVICES: List any tours, activities, or services mentioned with duration or capacity if given.
2. PRICING: List any specific prices, rates, or payment terms mentioned.
3. HOURS: List any business hours, availability windows, or days mentioned.
4. TONE: In 1 sentence, describe the owner's communication style (e.g. "warm and casual, uses first names, signs off as Karenda").

Respond in this exact JSON format:
{
  "services": "...",
  "pricing": "...",
  "hours": "...",
  "tone": "...",
  "summary": "One friendly sentence summarizing what you learned, written as Caye speaking to the owner (e.g. 'I can see you run snorkeling and glass-bottom boat tours — I've already got your pricing and hours noted.')."
}

If a section has nothing to extract, set it to an empty string "".`

  try {
    const response = await loggedMessagesCreate(anthropic, {
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }, { source: 'app/api/caye/discovery/route.ts:extractBusinessKnowledge' })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[discovery] Claude response did not contain JSON:', rawText.slice(0, 200))
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      services: string
      pricing: string
      hours: string
      tone: string
      summary: string
    }

    const parts: string[] = []
    if (parsed.services) parts.push(`SERVICES:\n${parsed.services}`)
    if (parsed.pricing) parts.push(`PRICING:\n${parsed.pricing}`)
    if (parsed.hours) parts.push(`HOURS:\n${parsed.hours}`)
    if (parsed.tone) parts.push(`OWNER TONE:\n${parsed.tone}`)

    return {
      systemPromptAddition: parts.join('\n\n'),
      pricingInfo: parsed.pricing || '',
      summary: parsed.summary || '',
    }
  } catch (err) {
    console.error('[discovery] Claude extraction failed:', err)
    return null
  }
}

export async function POST(req: NextRequest) {
  // Auth: Bearer JWT or internal discovery secret
  const authHeader = req.headers.get('authorization')
  const internalSecret = req.headers.get('x-discovery-secret')
  const expectedSecret = process.env.DISCOVERY_SECRET

  let workspaceId: string

  try {
    const body = await req.json() as { workspaceId?: string }
    workspaceId = body?.workspaceId || ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  // Validate caller is the workspace owner or an internal server call
  const isInternalCall = expectedSecret && internalSecret === expectedSecret
  if (!isInternalCall) {
    const accessToken = authHeader?.replace('Bearer ', '')
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userClient = createServerClient(accessToken)
    const { data: { user } } = await userClient.auth.getUser()
    if (!user || (user.id !== workspaceId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const supabase = createServiceClient()

  // 1. Mark discovery as in-progress
  await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        metadata: { discovery_status: 'running', discovery_started_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  // 2. Fetch the active Zoho email account
  const { data: emailAccount } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!emailAccount) {
    console.warn('[discovery] No active Zoho email account found for workspace:', workspaceId)
    await supabase
      .from('workspace_ai_config')
      .upsert(
        {
          workspace_id: workspaceId,
          metadata: { discovery_status: 'no_account', discovery_finished_at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id' }
      )
    return NextResponse.json({ ok: false, reason: 'no_email_account' })
  }

  // 3. Refresh Zoho token if needed
  let accessToken = String(emailAccount.access_token || '')
  if (tokenExpiresSoon(emailAccount.token_expires_at as string | null)) {
    const refreshed = await refreshZohoToken(String(emailAccount.refresh_token || ''))
    if (refreshed) {
      accessToken = refreshed.accessToken
      await supabase
        .from('connected_accounts')
        .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
        .eq('id', emailAccount.id)
    }
  }

  const meta = (emailAccount.metadata || {}) as Record<string, string>
  const accountId = meta.zoho_account_id || String(emailAccount.channel_account_id)
  const base = mailBase(meta.zoho_api_domain || 'https://www.zohoapis.com')

  // 4. Fetch the owner's workspace record to get their name / business name
  const { data: workspace } = await supabase
    .from('customers')
    .select('full_name, business_name')
    .eq('id', workspaceId)
    .maybeSingle()

  const firstName = (workspace?.full_name || '').split(' ')[0] || ''
  const businessName = workspace?.business_name || 'your business'

  // 5. Read recent sent messages
  const sentMessages = await fetchSentMessages(base, accountId, accessToken, 30)
  console.log(`[discovery] Fetched ${sentMessages.length} sent messages for workspace ${workspaceId}`)

  // 6. Extract business knowledge (or fallback to conversational intake)
  let greetingText: string
  let discoveryStatus: string

  if (sentMessages.length === 0) {
    // Empty inbox fallback — ask the owner conversationally
    greetingText = buildConversationalIntakeMessage(firstName)
    discoveryStatus = 'empty_inbox'
  } else {
    const extracted = await extractBusinessKnowledge(businessName, sentMessages)

    if (extracted) {
      // Persist to workspace_ai_config
      const { data: existingConfig } = await supabase
        .from('workspace_ai_config')
        .select('system_prompt, pricing_info, metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle()

      const existingPrompt = (existingConfig?.system_prompt as string | null) || ''
      const newPrompt = existingPrompt
        ? `${existingPrompt}\n\n---\n${extracted.systemPromptAddition}`
        : extracted.systemPromptAddition

      const existingMeta = (existingConfig?.metadata as Record<string, unknown> | null) || {}

      await supabase
        .from('workspace_ai_config')
        .upsert(
          {
            workspace_id: workspaceId,
            system_prompt: newPrompt,
            pricing_info: extracted.pricingInfo || (existingConfig?.pricing_info as string | null) || null,
            metadata: {
              ...existingMeta,
              discovery_status: 'done',
              discovery_finished_at: new Date().toISOString(),
              discovery_messages_read: sentMessages.length,
            },
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id' }
        )

      const greeting = firstName
        ? `Hey ${firstName} — I just read through your recent emails.`
        : 'Hey — I just read through your recent emails.'

      const body = extracted.summary
        ? `${greeting} ${extracted.summary}`
        : `${greeting} I've noted what I found about your services and will use it when helping customers.`

      greetingText = `${body}\n\nAsk me anything, or just start talking to me like you would a new member of your team.`
      discoveryStatus = 'done'
    } else {
      // LLM failed — still mark done but use fallback greeting
      greetingText = buildConversationalIntakeMessage(firstName)
      discoveryStatus = 'extraction_failed'

      await supabase
        .from('workspace_ai_config')
        .upsert(
          {
            workspace_id: workspaceId,
            metadata: {
              discovery_status: discoveryStatus,
              discovery_finished_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id' }
        )
    }
  }

  // 7. Insert Caye's first greeting message into the owner's local thread store
  // We write a special discovery_greeting row to workspace_ai_config so the
  // HomeScreen can pick it up and show it as Caye's first message.
  await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        metadata: {
          discovery_status: discoveryStatus,
          discovery_finished_at: new Date().toISOString(),
          discovery_greeting: greetingText,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  console.log(`[discovery] Completed for workspace ${workspaceId} — status: ${discoveryStatus}`)

  return NextResponse.json({
    ok: true,
    status: discoveryStatus,
    greeting: greetingText,
  })
}
