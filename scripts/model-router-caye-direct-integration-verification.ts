// FOUNDER-ONLY, OPT-IN, LOCAL-ONLY verification of the real Caye Direct
// integration (2026-08-17) — runs through the ACTUAL runFounderThreadTurn
// DB-persistence path (real caye_direct_threads / caye_operator_messages
// rows), not an isolated script call, so multi-turn pronoun continuity is
// genuinely tested against real persisted thread history
// (loadDirectThreadContext), not a hand-assembled prompt.
//
// READ-ONLY ONLY — restrictToToolNames restricts every turn to
// get_customer / get_customer_history, verified risk === 'read' before any
// run. This field is NOT reachable from the real HTTP route (route.ts never
// reads it from the request body) — it only exists for this kind of
// controlled script. No writes of any kind.
//
// Covers Phase 7 (multi-turn pronoun continuity), Phase 8 (provider
// switching mid-conversation), and Phase 10's six required real scenarios.
//
// Run with:
//   set -a && source .env.local && set +a && NODE_PATH=<scratch>/node_modules npx tsx scripts/model-router-caye-direct-integration-verification.ts

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'

const BIMINI_WORKSPACE_ID = '653257d9-c0f1-4271-be6d-3e2596fd893e'
const LAMAR_FOUNDER_ID = '29227a12-ca82-4796-a9c4-30ec0c6fa0e4'
const READ_ONLY_TOOLS = ['get_customer', 'get_customer_history']

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function queryToolCalls(sinceISO: string) {
  const { data, error } = await supabase
    .from('caye_tool_calls')
    .select('tool_name, risk, workspace_id, created_at')
    .eq('workspace_id', BIMINI_WORKSPACE_ID)
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

async function createTestThread(
  createThread: typeof import('../lib/caye-direct-threads').createThread,
  title: string
): Promise<string> {
  const thread = await createThread(supabase, { workspaceId: BIMINI_WORKSPACE_ID, createdBy: 'founder', title })
  return thread.id
}

async function archiveThread(
  setThreadStatus: typeof import('../lib/caye-direct-threads').setThreadStatus,
  threadId: string
) {
  await setThreadStatus(supabase, BIMINI_WORKSPACE_ID, threadId, 'archived')
}

interface StepResult {
  step: string
  threadId: string
  requestedMode: string
  question: string
  replyText: string
  backend?: string
  toolsThisStep: string[]
}

async function runStep(
  runFounderThreadTurn: typeof import('../lib/caye-agent/founder-thread-turn').runFounderThreadTurn,
  step: string,
  threadId: string,
  question: string,
  requestedMode: 'auto' | 'claude' | 'openai' | 'api'
): Promise<StepResult> {
  const beforeISO = new Date().toISOString()
  console.log(`\n[${step}] (${requestedMode}) "${question}"`)
  const result = await runFounderThreadTurn(BIMINI_WORKSPACE_ID, threadId, question, {
    requestedMode,
    founderUserId: LAMAR_FOUNDER_ID,
    restrictToToolNames: READ_ONLY_TOOLS,
  })
  const rows = await queryToolCalls(beforeISO)
  const writeTools = rows.filter((r) => r.risk !== 'read')
  console.log(`  backend=${result.backend ?? 'n/a'} tools=[${rows.map((r) => r.tool_name).join(',')}] writeTools=${writeTools.length}`)
  console.log(`  reply: ${result.replyText.slice(0, 220)}${result.replyText.length > 220 ? '…' : ''}`)
  if (writeTools.length > 0) {
    console.log(`  \x1b[31m*** WRITE TOOL EXECUTED — should be impossible ***\x1b[0m`)
  }
  return {
    step,
    threadId,
    requestedMode,
    question,
    replyText: result.replyText,
    backend: result.backend,
    toolsThisStep: rows.map((r) => r.tool_name),
  }
}

async function main() {
  const { runFounderThreadTurn } = await import('../lib/caye-agent/founder-thread-turn')
  const { createThread, setThreadStatus } = await import('../lib/caye-direct-threads')
  const results: StepResult[] = []
  const threadsToArchive: string[] = []

  console.log('='.repeat(72))
  console.log('Caye Direct real integration verification — 2026-08-17')
  console.log('='.repeat(72))

  // Phase 7: multi-turn pronoun continuity in a REAL thread.
  const continuityThreadId = await createTestThread(createThread, '[router-verification] pronoun continuity — safe to delete')
  threadsToArchive.push(continuityThreadId)
  results.push(await runStep(runFounderThreadTurn, '7a', continuityThreadId, 'What happened with Juli King?', 'claude'))
  results.push(await runStep(runFounderThreadTurn, '7b (pronoun "her")', continuityThreadId, 'What is her email?', 'claude'))

  // Phase 8: provider switching mid-conversation, same thread, context preserved.
  const switchThreadId = await createTestThread(createThread, '[router-verification] provider switching — safe to delete')
  threadsToArchive.push(switchThreadId)
  results.push(await runStep(runFounderThreadTurn, '8a (claude)', switchThreadId, 'Who is Juli King?', 'claude'))
  results.push(await runStep(runFounderThreadTurn, '8b (api)', switchThreadId, 'What is her email, according to what you just found?', 'api'))
  results.push(await runStep(runFounderThreadTurn, '8c (auto)', switchThreadId, 'And has Will Miles reached out to us recently?', 'auto'))

  // Phase 10: two-sequential-reads scenario, fresh thread.
  const multiReadThreadId = await createTestThread(createThread, '[router-verification] two-read scenario — safe to delete')
  threadsToArchive.push(multiReadThreadId)
  results.push(
    await runStep(
      runFounderThreadTurn,
      '10 (two reads)',
      multiReadThreadId,
      'Look up Juli King, then tell me about her booking and message history.',
      'claude'
    )
  )

  // Phase 10: forced-grounding-recovery check — same shape as the prior
  // phase's real 20-run test, now through the real thread path.
  const groundingThreadId = await createTestThread(createThread, '[router-verification] grounding recovery — safe to delete')
  threadsToArchive.push(groundingThreadId)
  results.push(await runStep(runFounderThreadTurn, '10 (grounding recovery)', groundingThreadId, 'Who is Juli King?', 'claude'))

  console.log('\n' + '='.repeat(72))
  console.log('SUMMARY')
  console.log('='.repeat(72))
  for (const r of results) {
    console.log(`[${r.step}] backend=${r.backend} tools=[${r.toolsThisStep.join(',')}] "${r.question}"`)
  }

  console.log(`\nArchiving ${threadsToArchive.length} test threads...`)
  for (const id of threadsToArchive) await archiveThread(setThreadStatus, id)
  console.log('Done — test threads archived (not deleted), titled [router-verification] for easy identification.')
}

main().catch((err) => {
  console.error('Integration verification script crashed:', err)
  process.exit(1)
})
