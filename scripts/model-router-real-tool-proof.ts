// FOUNDER-ONLY, OPT-IN, LOCAL-ONLY controlled proof: a real, subscription-
// authenticated Claude Code CLI invocation, reasoning through
// runFounderToolLoop, invoking a REAL Caye business tool (read-only,
// structurally restricted — see restrictToToolNames), against REAL
// Bimini Island Tours data in Supabase.
//
// READ-ONLY ONLY. Every tool exposed to the model in this script has
// risk === 'read', verified programmatically before any tool is exposed.
// No WhatsApp/email sends, no booking writes, no payment links, no
// reminders — nothing capable of an external side effect is ever placed
// in the tool manifest the model sees.
//
// Also proves the negative: a malformed tool call and a call to a tool
// outside the restricted set are both rejected by Caye's own validation
// code (schema-validate.ts / the unknown-tool branch) BEFORE
// runToolWithRecovery ever runs — driven by a fake backend that returns a
// deliberately bad tool_use block directly, not by trying to provoke real
// misbehavior from the live CLI.
//
// Run with:
//   set -a && source .env.local && set +a && npx tsx scripts/model-router-real-tool-proof.ts

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { ClaudeSubscriptionBackend } from '../lib/model-router/backends/claude-subscription'
import { runFounderToolLoop } from '../lib/model-router/tool-bridge/founder-tool-loop'
import { DEFAULT_ROUTER_POLICY } from '../lib/model-router/router'
import { TOOL_REGISTRY } from '../lib/caye-agent/tools/registry'
import { buildBackOfficeSystemPrompt } from '../lib/caye-agent/modes/back-office'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../lib/model-router/tool-bridge/types'
import type { FounderRouterContext } from '../lib/model-router/types'
import type { ToolContext } from '../lib/caye-agent/tools/types'
import type Anthropic from '@anthropic-ai/sdk'

process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'

const BIMINI_WORKSPACE_ID = '653257d9-c0f1-4271-be6d-3e2596fd893e'
const LAMAR_FOUNDER_ID = '29227a12-ca82-4796-a9c4-30ec0c6fa0e4' // classicalsineus@gmail.com, from lib/founder.ts

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

async function fetchBiminiProfile() {
  const { data } = await supabase
    .from('customers')
    .select('business_name, full_name, contact_email, contact_phone, whatsapp_business_number, timezone')
    .eq('id', BIMINI_WORKSPACE_ID)
    .maybeSingle()
  return data
}

function toolCtx(requestId: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: BIMINI_WORKSPACE_ID,
    callerRole: 'founder',
    operatorId: null,
    requestId,
    directThreadLinks: [],
    ...overrides,
  }
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

async function main() {
  section('PHASE 1 — PREFLIGHT')
  console.log(`HEAD: (reported separately by the calling session, not re-derived here)`)
  console.log(`CAYE_DIRECT_LOCAL_BRIDGE=${process.env.CAYE_DIRECT_LOCAL_BRIDGE}`)
  console.log(`ANTHROPIC_API_KEY present in parent env: ${!!process.env.ANTHROPIC_API_KEY}`)

  const claude = new ClaudeSubscriptionBackend()
  const health = await claude.checkHealth()
  if (health.state !== 'available') {
    fail('claude_subscription health', JSON.stringify(health))
    process.exit(1)
  }
  ok('claude_subscription health', JSON.stringify(health))

  const profile = await fetchBiminiProfile()
  if (!profile) {
    fail('Bimini workspace lookup', 'no row found for ' + BIMINI_WORKSPACE_ID)
    process.exit(1)
  }
  ok('Bimini workspace lookup', `business_name=${profile.business_name}`)

  section('PHASE 2 — TOOL EXPOSURE (structural read-only restriction)')
  const getCustomerTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer')
  const getCustomerHistoryTool = TOOL_REGISTRY.find((t) => t.name === 'get_customer_history')
  if (!getCustomerTool || getCustomerTool.risk !== 'read') {
    fail('get_customer risk check', `risk=${getCustomerTool?.risk ?? 'NOT FOUND'} — STOPPING`)
    process.exit(1)
  }
  ok('get_customer risk check', `risk === 'read' (roles: ${getCustomerTool.roles.join(',')})`)
  if (!getCustomerHistoryTool || getCustomerHistoryTool.risk !== 'read') {
    fail('get_customer_history risk check', `risk=${getCustomerHistoryTool?.risk ?? 'NOT FOUND'} — STOPPING`)
    process.exit(1)
  }
  ok('get_customer_history risk check', `risk === 'read' (roles: ${getCustomerHistoryTool.roles.join(',')})`)

  const system = buildBackOfficeSystemPrompt({
    profile: {
      operatorName: profile.full_name ?? null,
      businessName: profile.business_name ?? null,
      tagline: null,
      website: null,
      contactEmail: profile.contact_email ?? null,
      contactPhone: profile.contact_phone ?? null,
      whatsappBusinessNumber: profile.whatsapp_business_number ?? null,
      businessAddress: null,
      operatorPersonalEmail: null,
      operatorPersonalPhone: null,
      teamNotes: null,
      businessHoursDisplay: null,
      paymentMethods: null,
      timezone: profile.timezone ?? null,
    },
    voiceProfile: null,
    caller: { role: 'founder', name: 'Lamar (real-tool-proof controlled test)' },
  })

  section('PHASE 3 — REAL END-TO-END TEST (single read tool)')
  const phase3RequestId = randomUUID()
  const phase3Question = 'Do we have any contact info on file for a customer named Juli King?'
  console.log(`Request: "${phase3Question}"`)
  console.log(`requestId: ${phase3RequestId}`)

  const phase3 = await runFounderToolLoop({
    ctx: founderCtx('real-tool-proof-phase3'),
    requestedMode: 'claude',
    backends: [claude], // ONLY Claude registered — no API backend exists to fall back to
    policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
    toolCtx: toolCtx(phase3RequestId),
    system,
    initialMessages: [{ role: 'user', content: phase3Question }],
    signal: new AbortController().signal,
    restrictToToolNames: ['get_customer'],
  })

  console.log('\n--- newTurns (evidence) ---')
  for (const [i, turn] of phase3.newTurns.entries()) {
    console.log(`Turn ${i} [${turn.role}]:`, JSON.stringify(turn.content).slice(0, 500))
  }
  console.log('\n--- decision ---', JSON.stringify(phase3.decision))
  console.log('\n--- final reply ---\n' + phase3.replyText)

  const phase3ToolUse = phase3.newTurns.some(
    (t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_use' && b.name === 'get_customer')
  )
  const phase3ToolResult = phase3.newTurns.some((t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_result'))
  if (phase3ToolUse) ok('Claude emitted a structured get_customer request', 'confirmed in newTurns')
  else fail('Claude emitted a structured get_customer request', 'NOT found in newTurns')
  if (phase3ToolResult) ok('A tool_result turn was produced', 'confirmed in newTurns')
  else fail('A tool_result turn was produced', 'NOT found in newTurns')

  section('PHASE 4 — MULTI-ROUND TEST (get_customer -> get_customer_history)')
  const phase4RequestId = randomUUID()
  const phase4Question =
    'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.'
  console.log(`Request: "${phase4Question}"`)
  console.log(`requestId: ${phase4RequestId}`)

  const phase4 = await runFounderToolLoop({
    ctx: founderCtx('real-tool-proof-phase4'),
    requestedMode: 'claude',
    backends: [claude],
    policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
    toolCtx: toolCtx(phase4RequestId),
    system,
    initialMessages: [{ role: 'user', content: phase4Question }],
    signal: new AbortController().signal,
    restrictToToolNames: ['get_customer', 'get_customer_history'],
  })

  console.log('\n--- newTurns (evidence) ---')
  for (const [i, turn] of phase4.newTurns.entries()) {
    console.log(`Turn ${i} [${turn.role}]:`, JSON.stringify(turn.content).slice(0, 500))
  }
  console.log('\n--- final reply ---\n' + phase4.replyText)

  const assistantRounds = phase4.newTurns.filter((t) => t.role === 'assistant').length
  const calledHistory = phase4.newTurns.some(
    (t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_use' && b.name === 'get_customer_history')
  )
  console.log(`\nAssistant rounds this turn: ${assistantRounds}`)
  console.log(`get_customer_history was called: ${calledHistory}`)
  if (assistantRounds >= 2) ok('Multi-round reasoning', `${assistantRounds} assistant rounds`)
  else fail('Multi-round reasoning', `only ${assistantRounds} assistant round(s) — model may have declined the second lookup`)

  section('PHASE 5 — FAILURE CHECK (fake backend, direct injection, no real business action)')

  const phase5aRequestId = randomUUID()
  const malformedBackend: ToolCapableBackend = {
    id: 'claude_subscription',
    provider: 'anthropic',
    authMode: 'subscription_cli',
    capabilities: ['general_reasoning'],
    checkHealth: async () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    invoke: async () => ({ backend: 'claude_subscription', text: 'unused', latencyMs: 1 }),
    invokeTurn: async (req: ToolTurnRequest): Promise<ToolTurnResult> => {
      // First call: deliberately malformed (missing required `query`).
      // Second call (after Caye's rejection is fed back): give up cleanly.
      const alreadyRejected = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
      )
      if (alreadyRejected) {
        return { content: [{ type: 'text', text: 'Could not complete that lookup.', citations: null }], latencyMs: 1 }
      }
      return {
        content: [
          { type: 'tool_use', id: 'malformed_1', name: 'get_customer', input: {}, caller: { type: 'direct' } } as Anthropic.ContentBlock,
        ],
        latencyMs: 1,
        toolCallsFromStructuredText: true,
      }
    },
  }
  const phase5a = await runFounderToolLoop({
    ctx: founderCtx('real-tool-proof-phase5a'),
    requestedMode: 'claude',
    backends: [malformedBackend],
    policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
    toolCtx: toolCtx(phase5aRequestId),
    system,
    initialMessages: [{ role: 'user', content: 'trigger' }],
    signal: new AbortController().signal,
    restrictToToolNames: ['get_customer'],
  })
  const phase5aRejected = phase5a.newTurns.some(
    (t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_result' && JSON.stringify(b.content).includes('Invalid arguments'))
  )
  if (phase5aRejected) ok('Malformed tool call rejected pre-execution', 'schema-validate.ts caught it')
  else fail('Malformed tool call rejected pre-execution', 'NOT rejected as expected')

  const phase5bRequestId = randomUUID()
  const unknownToolBackend: ToolCapableBackend = {
    ...malformedBackend,
    invokeTurn: async (req: ToolTurnRequest): Promise<ToolTurnResult> => {
      const alreadyRejected = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
      )
      if (alreadyRejected) {
        return { content: [{ type: 'text', text: 'Could not complete that.', citations: null }], latencyMs: 1 }
      }
      return {
        content: [
          {
            type: 'tool_use',
            id: 'unknown_1',
            name: 'schedule_reminder', // real registry tool, WRITE risk, but excluded from the restricted manifest
            input: { note: 'should never run' },
            caller: { type: 'direct' },
          } as Anthropic.ContentBlock,
        ],
        latencyMs: 1,
        toolCallsFromStructuredText: true,
      }
    },
  }
  const phase5b = await runFounderToolLoop({
    ctx: founderCtx('real-tool-proof-phase5b'),
    requestedMode: 'claude',
    backends: [unknownToolBackend],
    policy: { ...DEFAULT_ROUTER_POLICY, allowApiFallback: false },
    toolCtx: toolCtx(phase5bRequestId),
    system,
    initialMessages: [{ role: 'user', content: 'trigger' }],
    signal: new AbortController().signal,
    restrictToToolNames: ['get_customer'],
  })
  const phase5bRejected = phase5b.newTurns.some(
    (t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_result' && JSON.stringify(b.content).includes('Unknown tool'))
  )
  if (phase5bRejected) ok('Unknown/excluded tool call rejected pre-execution', 'never reached TOOL_REGISTRY execution')
  else fail('Unknown/excluded tool call rejected pre-execution', 'NOT rejected as expected')

  section('PHASE 6 — caye_tool_calls EVIDENCE (real rows, read-only)')
  for (const [label, id] of [
    ['Phase 3 (get_customer)', phase3RequestId],
    ['Phase 4 (get_customer + get_customer_history)', phase4RequestId],
    ['Phase 5a (malformed — should be EMPTY, never executed)', phase5aRequestId],
    ['Phase 5b (unknown/excluded — should be EMPTY, never executed)', phase5bRequestId],
  ] as const) {
    const rows = await queryToolCalls(id)
    console.log(`\n${label}: ${rows.length} row(s)`)
    for (const r of rows) console.log('  ', JSON.stringify(r))
  }

  section('DONE')
}

main().catch((err) => {
  console.error('Real-tool-proof script crashed:', err)
  process.exit(1)
})
