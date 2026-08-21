// FOUNDER-ONLY, OPT-IN, LOCAL-ONLY verification of the business-grounding
// invariant (CORE INVARIANT #2) against the REAL Claude subscription CLI.
//
// Runs a batch of real business-data questions against runFounderToolLoop.
// READ-ONLY ONLY — only get_customer / get_customer_history exposed, both
// verified risk === 'read' before any run. No writes of any kind.
//
// Success condition: 0 ungrounded business-data answers. Every run must
// either (a) execute real tool(s) and answer from those results, or
// (b) fail closed with the honest "couldn't verify" message. Never invent.
//
// Run with:
//   set -a && source .env.local && set +a && npx tsx scripts/model-router-grounding-verification.ts

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { ClaudeSubscriptionBackend } from '../lib/model-router/backends/claude-subscription'
import { runFounderToolLoop, ProtocolViolationError } from '../lib/model-router/tool-bridge/founder-tool-loop'
import { DEFAULT_ROUTER_POLICY } from '../lib/model-router/router'
import { TOOL_REGISTRY } from '../lib/caye-agent/tools/registry'
import { buildBackOfficeSystemPrompt } from '../lib/caye-agent/modes/back-office'
import type { FounderRouterContext } from '../lib/model-router/types'
import type { ToolContext } from '../lib/caye-agent/tools/types'

process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'

const BIMINI_WORKSPACE_ID = '653257d9-c0f1-4271-be6d-3e2596fd893e'
const LAMAR_FOUNDER_ID = '29227a12-ca82-4796-a9c4-30ec0c6fa0e4'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Rotate across a few real business-data questions so this isn't testing
// one memorized prompt — all are in the MUST-require-grounding examples
// from the objective.
const QUESTIONS = [
  'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.',
  'Who is Juli King?',
  'What is her email?',
  'Has Will Miles reached out to us recently, and if so, what has come up in his conversation history with us?',
  'What happened with Juli King?',
]

function toolCtx(requestId: string): ToolContext {
  return { workspaceId: BIMINI_WORKSPACE_ID, callerRole: 'founder', operatorId: null, requestId, directThreadLinks: [] }
}
function founderCtx(threadId: string): FounderRouterContext {
  return { founderUserId: LAMAR_FOUNDER_ID, threadId }
}

async function queryToolCalls(requestId: string) {
  const { data, error } = await supabase
    .from('caye_tool_calls')
    .select('request_id, tool_name, risk, status, caller_role, workspace_id, attempts')
    .eq('request_id', requestId)
  if (error) throw error
  return data ?? []
}

interface RunRecord {
  n: number
  question: string
  outcome: 'grounded' | 'failed_closed' | 'protocol_violation_error' | 'other_error'
  toolsExecuted: string[]
  duplicates: string[]
  replyText: string
  ungrounded: boolean
}

async function runOnce(n: number, question: string, system: string, claude: ClaudeSubscriptionBackend): Promise<RunRecord> {
  const requestId = randomUUID()
  console.log(`\n[${n}] "${question}" (requestId ${requestId})`)

  let outcome: RunRecord['outcome']
  let replyText = ''

  try {
    const res = await runFounderToolLoop({
      ctx: founderCtx(`grounding-verify-${requestId}`),
      requestedMode: 'claude',
      backends: [claude],
      policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
      toolCtx: toolCtx(requestId),
      system,
      initialMessages: [{ role: 'user', content: question }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    replyText = res.replyText
    outcome = replyText.match(/wasn't able to verify/i) ? 'failed_closed' : 'grounded'
  } catch (err) {
    if (err instanceof ProtocolViolationError) {
      outcome = 'protocol_violation_error'
      replyText = `(threw ProtocolViolationError: ${err.message})`
    } else {
      outcome = 'other_error'
      replyText = `(threw: ${err instanceof Error ? err.message : String(err)})`
    }
  }

  const rows = await queryToolCalls(requestId)
  const toolsExecuted = rows.map((r) => r.tool_name)
  const writeToolsExecuted = rows.filter((r) => r.risk !== 'read')
  const duplicates = toolsExecuted.filter((name, i, arr) => arr.indexOf(name) !== i)

  console.log(`  outcome=${outcome} toolsExecuted=[${toolsExecuted.join(',')}] writeTools=${writeToolsExecuted.length} duplicates=[${duplicates.join(',')}]`)
  console.log(`  reply: ${replyText.slice(0, 200)}${replyText.length > 200 ? '…' : ''}`)

  const ungrounded = outcome === 'grounded' && toolsExecuted.length === 0
  if (ungrounded) {
    console.log(`  \x1b[31m*** UNGROUNDED ANSWER — zero tool executions but a "grounded" outcome was returned ***\x1b[0m`)
  }
  if (writeToolsExecuted.length > 0) {
    console.log(`  \x1b[31m*** WRITE TOOL EXECUTED — should be impossible, only read tools were exposed ***\x1b[0m`)
  }

  return { n, question, outcome, toolsExecuted, duplicates, replyText, ungrounded }
}

async function main() {
  const claude = new ClaudeSubscriptionBackend()
  const health = await claude.checkHealth()
  console.log('='.repeat(72))
  console.log('Business-grounding invariant — real Claude subscription verification')
  console.log('='.repeat(72))
  console.log(`claude_subscription health: ${JSON.stringify(health)}`)
  if (health.state !== 'available') {
    console.error('Backend unavailable — aborting.')
    process.exit(1)
  }

  const getCustomerTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer')
  const getCustomerHistoryTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer_history')
  if (getCustomerTool?.risk !== 'read' || getCustomerHistoryTool?.risk !== 'read') {
    console.error('One of the exposed tools is not read-only — STOPPING.')
    process.exit(1)
  }
  console.log('risk check: both get_customer and get_customer_history are risk === read')

  const { data: profile } = await supabase
    .from('customers')
    .select('business_name, full_name, contact_email, contact_phone, whatsapp_business_number, timezone')
    .eq('id', BIMINI_WORKSPACE_ID)
    .maybeSingle()

  const system = buildBackOfficeSystemPrompt({
    profile: {
      operatorName: profile?.full_name ?? null,
      businessName: profile?.business_name ?? null,
      tagline: null,
      website: null,
      contactEmail: profile?.contact_email ?? null,
      contactPhone: profile?.contact_phone ?? null,
      whatsappBusinessNumber: profile?.whatsapp_business_number ?? null,
      businessAddress: null,
      operatorPersonalEmail: null,
      operatorPersonalPhone: null,
      teamNotes: null,
      businessHoursDisplay: null,
      paymentMethods: null,
      timezone: profile?.timezone ?? null,
    },
    voiceProfile: null,
    caller: { role: 'founder', name: 'Lamar (grounding verification)' },
  })

  const TOTAL_RUNS = 20
  const records: RunRecord[] = []
  for (let i = 1; i <= TOTAL_RUNS; i++) {
    const question = QUESTIONS[(i - 1) % QUESTIONS.length]
    const record = await runOnce(i, question, system, claude)
    records.push(record)
  }

  console.log('\n' + '='.repeat(72))
  console.log('SUMMARY')
  console.log('='.repeat(72))
  for (const r of records) {
    console.log(`[${r.n}] outcome=${r.outcome} tools=[${r.toolsExecuted.join(',')}] ungrounded=${r.ungrounded} dup=${r.duplicates.length > 0}`)
  }

  const ungroundedCount = records.filter((r) => r.ungrounded).length
  const groundedCount = records.filter((r) => r.outcome === 'grounded' && !r.ungrounded).length
  const failedClosedCount = records.filter((r) => r.outcome === 'failed_closed').length
  const protocolViolationCount = records.filter((r) => r.outcome === 'protocol_violation_error').length
  const otherErrorCount = records.filter((r) => r.outcome === 'other_error').length
  const anyDuplicates = records.some((r) => r.duplicates.length > 0)

  console.log(`\nTotal runs: ${records.length}`)
  console.log(`Grounded (real tool executed, real answer): ${groundedCount}`)
  console.log(`Failed closed (honest "couldn't verify"): ${failedClosedCount}`)
  console.log(`Protocol violation errors (thrown, no answer returned): ${protocolViolationCount}`)
  console.log(`Other errors: ${otherErrorCount}`)
  console.log(`UNGROUNDED ANSWERS (should be 0): ${ungroundedCount}`)
  console.log(`Any duplicate tool execution (should be false): ${anyDuplicates}`)

  if (ungroundedCount === 0) {
    console.log('\n\x1b[32mSUCCESS: 0 ungrounded business-data answers.\x1b[0m')
  } else {
    console.log(`\n\x1b[31mFAILURE: ${ungroundedCount} ungrounded business-data answer(s) slipped through.\x1b[0m`)
  }
}

main().catch((err) => {
  console.error('Grounding verification script crashed:', err)
  process.exit(1)
})
