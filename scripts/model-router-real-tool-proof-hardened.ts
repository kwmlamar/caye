// FOUNDER-ONLY, OPT-IN, LOCAL-ONLY re-verification after provenance
// hardening (protocol-artifact-guard.ts, tightened Claude protocol,
// CAYE_RUNTIME_TOOL_RESULT marker, same-backend retry).
//
// Reruns the EXACT natural-language request that produced a fabricated
// tool transcript twice on 2026-08-16, three times against the real
// Claude subscription CLI, plus a second, independently-constructed
// natural two-read question. READ-ONLY ONLY — same restrictions as
// scripts/model-router-real-tool-proof.ts.
//
// Run with:
//   set -a && source .env.local && set +a && npx tsx scripts/model-router-real-tool-proof-hardened.ts

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { ClaudeSubscriptionBackend } from '../lib/model-router/backends/claude-subscription'
import { runFounderToolLoop, ProtocolViolationError } from '../lib/model-router/tool-bridge/founder-tool-loop'
import { DEFAULT_ROUTER_POLICY } from '../lib/model-router/router'
import { TOOL_REGISTRY } from '../lib/caye-agent/tools/registry'
import { buildBackOfficeSystemPrompt } from '../lib/caye-agent/modes/back-office'
import type { FounderRouterContext } from '../lib/model-router/types'
import type { ToolContext } from '../lib/caye-agent/tools/types'
import type Anthropic from '@anthropic-ai/sdk'

process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'

const BIMINI_WORKSPACE_ID = '653257d9-c0f1-4271-be6d-3e2596fd893e'
const LAMAR_FOUNDER_ID = '29227a12-ca82-4796-a9c4-30ec0c6fa0e4'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

function section(title: string) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}
function ok(label: string, detail: string) {
  console.log(`[\x1b[32mOK\x1b[0m] ${label} — ${detail}`)
}
function fail(label: string, detail: string) {
  console.log(`[\x1b[31mFAIL\x1b[0m] ${label} — ${detail}`)
}

function toolCtx(requestId: string): ToolContext {
  return { workspaceId: BIMINI_WORKSPACE_ID, callerRole: 'founder', operatorId: null, requestId, directThreadLinks: [] }
}
function founderCtx(threadId: string): FounderRouterContext {
  return { founderUserId: LAMAR_FOUNDER_ID, threadId }
}

async function queryToolCalls(requestId: string) {
  const { data, error } = await supabase
    .from('caye_tool_calls')
    .select('request_id, tool_name, risk, status, caller_role, workspace_id, attempts, error_code')
    .eq('request_id', requestId)
  if (error) throw error
  return data ?? []
}

function containsFabricationTokens(text: string): boolean {
  return /tool_calls|tool_use|tool_result|TOOL RESULT|CAYE_RUNTIME_TOOL_RESULT/i.test(text)
}

async function runOnce(label: string, question: string, system: string, claude: ClaudeSubscriptionBackend) {
  const requestId = randomUUID()
  console.log(`\n--- ${label} ---`)
  console.log(`Question: "${question}"`)
  console.log(`requestId: ${requestId}`)

  let outcome: 'success' | 'protocol_violation' | 'other_error'
  let replyText = ''
  let newTurns: Anthropic.MessageParam[] = []

  try {
    const res = await runFounderToolLoop({
      ctx: founderCtx(`hardened-${requestId}`),
      requestedMode: 'claude',
      backends: [claude],
      policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
      toolCtx: toolCtx(requestId),
      system,
      initialMessages: [{ role: 'user', content: question }],
      signal: new AbortController().signal,
      restrictToToolNames: ['get_customer', 'get_customer_history'],
    })
    outcome = 'success'
    replyText = res.replyText
    newTurns = res.newTurns
  } catch (err) {
    if (err instanceof ProtocolViolationError) {
      outcome = 'protocol_violation'
      console.log(`ProtocolViolationError: ${err.message}`)
    } else {
      outcome = 'other_error'
      console.log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const rows = await queryToolCalls(requestId)
  const getCustomerCalled = rows.some((r) => r.tool_name === 'get_customer')
  const getCustomerHistoryCalled = rows.some((r) => r.tool_name === 'get_customer_history')
  const anyWriteTool = rows.some((r) => r.risk !== 'read')
  const anyFailed = rows.some((r) => r.status !== 'SUCCESS')
  const duplicateNames = rows.map((r) => r.tool_name).filter((name, i, arr) => arr.indexOf(name) !== i)

  console.log(`outcome: ${outcome}`)
  console.log(`caye_tool_calls rows (${rows.length}):`)
  for (const r of rows) console.log('  ', JSON.stringify(r))
  console.log(`get_customer executed: ${getCustomerCalled}`)
  console.log(`get_customer_history executed: ${getCustomerHistoryCalled}`)

  if (outcome === 'success') {
    console.log(`\nfinal reply:\n${replyText}`)
    const replyHasArtifacts = containsFabricationTokens(replyText)
    if (replyHasArtifacts) fail(`${label}: final answer free of protocol artifacts`, 'FOUND artifact tokens in replyText')
    else ok(`${label}: final answer free of protocol artifacts`, 'clean')
  }
  if (anyWriteTool) fail(`${label}: no write tool executed`, JSON.stringify(rows.filter((r) => r.risk !== 'read')))
  else ok(`${label}: no write tool executed`, 'confirmed — 0 non-read rows')
  if (duplicateNames.length > 0) fail(`${label}: no duplicate execution`, JSON.stringify(duplicateNames))
  else ok(`${label}: no duplicate execution`, 'confirmed — no repeated tool_name rows')
  if (anyFailed) console.log(`note: some rows are non-SUCCESS (may be legitimate, e.g. NOT_FOUND) — see rows above`)

  return { outcome, replyText, rows, getCustomerCalled, getCustomerHistoryCalled, newTurns }
}

async function main() {
  const claude = new ClaudeSubscriptionBackend()
  const health = await claude.checkHealth()
  section('PREFLIGHT')
  console.log(`CAYE_DIRECT_LOCAL_BRIDGE=${process.env.CAYE_DIRECT_LOCAL_BRIDGE}`)
  console.log(`ANTHROPIC_API_KEY present in parent env: ${!!process.env.ANTHROPIC_API_KEY}`)
  if (health.state !== 'available') {
    fail('claude_subscription health', JSON.stringify(health))
    process.exit(1)
  }
  ok('claude_subscription health', JSON.stringify(health))

  const getCustomerTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer')
  const getCustomerHistoryTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer_history')
  if (getCustomerTool?.risk !== 'read' || getCustomerHistoryTool?.risk !== 'read') {
    fail('risk check', 'one of the exposed tools is not read-only — STOPPING')
    process.exit(1)
  }
  ok('risk check', 'both get_customer and get_customer_history are risk === read')

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
    caller: { role: 'founder', name: 'Lamar (hardened re-verification)' },
  })

  section('RERUN 1/3 — original failing question')
  const r1 = await runOnce('Run 1', 'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.', system, claude)

  section('RERUN 2/3 — original failing question')
  const r2 = await runOnce('Run 2', 'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.', system, claude)

  section('RERUN 3/3 — original failing question')
  const r3 = await runOnce('Run 3', 'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.', system, claude)

  section('SECOND NATURAL TWO-READ QUESTION')
  const r4 = await runOnce(
    'Second question',
    'Has Will Miles reached out to us recently, and if so, what has come up in his conversation history with us?',
    system,
    claude
  )

  section('SUMMARY')
  for (const [label, r] of [['Run 1', r1], ['Run 2', r2], ['Run 3', r3], ['Second question', r4]] as const) {
    console.log(`${label}: outcome=${r.outcome} get_customer=${r.getCustomerCalled} get_customer_history=${r.getCustomerHistoryCalled}`)
  }
}

main().catch((err) => {
  console.error('Hardened re-verification script crashed:', err)
  process.exit(1)
})
