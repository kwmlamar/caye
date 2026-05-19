import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'

interface HistoryMessage {
  from: 'user' | 'caye'
  text: string
}

const CONFIG_BLOCK_RE = /```config\s*\n([\s\S]*?)\n```/

const KNOWN_FIELDS = new Set([
  'system_prompt',
  'tone',
  'never_say',
  'escalation_rules',
  'pricing_info',
  'common_questions',
  'cancellation_policy',
])

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_conversations',
    description:
      'Search the inbox for conversations. Use this whenever the owner asks about recent messages, emails, chats, customer activity, or anything that happened in the inbox. Always call this before saying you don\'t have information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format. For "today" use today\'s date.',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format. Optional — omit to search up to now.',
        },
        channel: {
          type: 'string',
          enum: ['email', 'whatsapp', 'instagram', 'messenger'],
          description: 'Filter by channel. Optional.',
        },
        status: {
          type: 'string',
          enum: ['open', 'pending', 'resolved'],
          description: 'Filter by conversation status. Optional.',
        },
        held_only: {
          type: 'boolean',
          description: 'If true, only return conversations held for human review.',
        },
        customer_name: {
          type: 'string',
          description: 'Filter by customer name (partial match). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 10, max 25.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_conversation_messages',
    description:
      'Get the full message thread for a specific conversation. Use this when the owner asks what was said in a particular thread, wants to see the details, or asks for a follow-up on a conversation from search results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        conversation_id: {
          type: 'string',
          description: 'The conversation ID returned by search_conversations.',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return. Default 20.',
        },
      },
      required: ['conversation_id'],
    },
  },
]

type SearchInput = {
  date_from?: string
  date_to?: string
  channel?: string
  status?: string
  held_only?: boolean
  customer_name?: string
  limit?: number
}

type GetMessagesInput = {
  conversation_id: string
  limit?: number
}

async function runSearchConversations(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  input: SearchInput
) {
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
    .eq('is_active', true)

  const accountIds = (accounts || []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return { conversations: [], total: 0 }

  let query = supabase
    .from('unified_conversations')
    .select('id, customer_name, channel_type, last_message_at, last_message_preview, status, human_agent_enabled, human_agent_reason, unread_count')
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false })
    .limit(Math.min(input.limit || 10, 25))

  if (input.date_from) {
    query = query.gte('last_message_at', `${input.date_from}T00:00:00.000Z`)
  }
  if (input.date_to) {
    query = query.lte('last_message_at', `${input.date_to}T23:59:59.999Z`)
  }
  if (input.channel) {
    query = query.eq('channel_type', input.channel)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.held_only) {
    query = query.eq('human_agent_enabled', true)
  }
  if (input.customer_name) {
    query = query.ilike('customer_name', `%${input.customer_name}%`)
  }

  const { data, error } = await query
  if (error) return { error: error.message }
  return { conversations: data || [], total: (data || []).length }
}

async function runGetConversationMessages(
  supabase: ReturnType<typeof createServiceClient>,
  input: GetMessagesInput
) {
  const { data, error } = await supabase
    .from('unified_messages')
    .select('sender_type, content, sent_at, message_type')
    .eq('conversation_id', input.conversation_id)
    .order('sent_at', { ascending: false })
    .limit(input.limit || 20)

  if (error) return { error: error.message }
  return { messages: ((data || []).reverse()) }
}

function buildSystemPrompt(businessName: string, existingPrompt?: string | null): string {
  const today = new Date().toISOString().split('T')[0]
  return `You are Caye, the AI receptionist for ${businessName}. The person talking to you is the business owner. Today's date is ${today}.

You have three jobs:
1. Answer questions about the inbox — use your tools to look up real conversations, messages, and customer activity before answering. Never say you don't have access to the inbox.
2. Answer questions about the business, customers, or how you handle things.
3. When the owner gives feedback or asks you to change how you respond — understand what they want, update your behavior going forward, and confirm casually.

When updating behavior, append this at the end of your response:
\`\`\`config
{ "field": "tone|never_say|pricing_info|common_questions|escalation_rules|cancellation_policy|system_prompt", "action": "append|replace", "value": "..." }
\`\`\`

Keep responses short and conversational. You are texting with your boss, not writing essays.${existingPrompt ? `\n\nContext about the business:\n${existingPrompt}` : ''}`
}

const MAX_TOOL_ITERATIONS = 5

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message: string; workspaceId: string; history?: HistoryMessage[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { message, workspaceId, history = [] } = body
  if (!message || !workspaceId) {
    return NextResponse.json({ error: 'message and workspaceId are required' }, { status: 400 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  if (user.id !== workspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const [{ data: workspace }, { data: aiConfig }] = await Promise.all([
    supabase.from('customers').select('business_name').eq('id', workspaceId).maybeSingle(),
    supabase.from('workspace_ai_config').select('*').eq('workspace_id', workspaceId).maybeSingle(),
  ])

  const businessName = workspace?.business_name || 'your business'
  const systemPrompt = buildSystemPrompt(businessName, aiConfig?.system_prompt)

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.from === 'user' ? 'user' : 'assistant',
    content: m.text,
  }))
  messages.push({ role: 'user', content: message })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let rawReply = ''

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text')
        if (textBlock && textBlock.type === 'text') rawReply = textBlock.text
        break
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          let result: unknown
          try {
            if (block.name === 'search_conversations') {
              result = await runSearchConversations(supabase, workspaceId, block.input as SearchInput)
            } else if (block.name === 'get_conversation_messages') {
              result = await runGetConversationMessages(supabase, block.input as GetMessagesInput)
            } else {
              result = { error: `Unknown tool: ${block.name}` }
            }
          } catch (err) {
            result = { error: String(err) }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        }

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      // Unexpected stop reason — take whatever text we have
      const textBlock = response.content.find((b) => b.type === 'text')
      if (textBlock && textBlock.type === 'text') rawReply = textBlock.text
      break
    }
  } catch (err) {
    console.error('[caye/chat] Claude error:', err)
    return NextResponse.json({ error: 'AI service error' }, { status: 500 })
  }

  const configMatch = rawReply.match(CONFIG_BLOCK_RE)
  const reply = rawReply.replace(CONFIG_BLOCK_RE, '').trim()
  let configUpdated = false
  let fieldChanged: string | undefined

  if (configMatch) {
    try {
      const parsed = JSON.parse(configMatch[1].trim())
      const { field, action, value } = parsed

      if (field && KNOWN_FIELDS.has(field) && value !== undefined) {
        let newValue = String(value)

        if (action === 'append') {
          const existing = aiConfig?.[field as keyof typeof aiConfig] as string | null | undefined
          if (existing) newValue = `${existing}\n${newValue}`
        }

        const { error: updateErr } = await supabase
          .from('workspace_ai_config')
          .upsert(
            {
              workspace_id: workspaceId,
              [field]: newValue,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'workspace_id' }
          )

        if (!updateErr) {
          configUpdated = true
          fieldChanged = field
        } else {
          console.error('[caye/chat] Config update failed:', updateErr)
        }
      }
    } catch (err) {
      console.error('[caye/chat] Config block parse error:', err)
    }
  }

  return NextResponse.json({ reply, configUpdated, fieldChanged })
}
