// FOUNDER-ONLY, OPT-IN, LOCAL-ONLY smoke test for the Caye Direct
// multi-model router's subscription backends (lib/model-router).
//
// Proves the actual installed `claude`/`codex` CLI versions on THIS
// machine behave the way claude-subscription.ts / openai-codex-
// subscription.ts assume — real invocations, real parsing, not mocks.
// Per the router brief: "Do not call this production-ready merely
// because unit tests pass... I want one real local Claude subscription
// invocation and one real local Codex subscription invocation proven
// before we wire Caye Direct to it."
//
// Never touches Caye's real TOOL_REGISTRY, Supabase, or any business
// data — the tool-call round trip below uses a synthetic no-op
// `ping_tool`, not a real registered tool. No WhatsApp messages, no
// bookings, no payment links, nothing reversible.
//
// Usage:
//   npx tsx scripts/model-router-smoke-test.ts
//
// Not run by any test suite, CI job, or route. Manually invoked only.

import { ClaudeSubscriptionBackend } from '../lib/model-router/backends/claude-subscription'
import { OpenAICodexSubscriptionBackend } from '../lib/model-router/backends/openai-codex-subscription'
import type { ToolTurnRequest } from '../lib/model-router/tool-bridge/types'
import type { Tool } from '../lib/caye-agent/tools/types'

process.env.CAYE_DIRECT_LOCAL_BRIDGE = '1'

const PING_TOOL: Tool<{ query: string }> = {
  name: 'ping_tool',
  description: 'A synthetic no-op test tool. Never touches real business data. Just echoes its input for this smoke test.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'read',
  roles: ['founder'],
  modes: ['back-office'],
  async execute() {
    return { ok: true, data: {} }
  },
}

interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

const results: CheckResult[] = []

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  const icon = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`[${icon}] ${name} — ${detail}`)
}

async function main() {
  console.log('='.repeat(72))
  console.log('Caye Direct model-router — FOUNDER-ONLY local smoke test')
  console.log('Does not touch Caye tools, Supabase, or any business data.')
  console.log('='.repeat(72))

  const claude = new ClaudeSubscriptionBackend()
  const codex = new OpenAICodexSubscriptionBackend()
  const signal = new AbortController().signal

  // --- Health checks ---
  const claudeHealth = await claude.checkHealth()
  record('claude_subscription health', claudeHealth.state === 'available', JSON.stringify(claudeHealth))

  const codexHealth = await codex.checkHealth()
  record('openai_codex_subscription health', codexHealth.state === 'available', JSON.stringify(codexHealth))

  // --- Plain text invocation ---
  if (claudeHealth.state === 'available') {
    try {
      const res = await claude.invoke(
        { ctx: { founderUserId: 'smoke-test', threadId: 'smoke-test' }, system: 'Reply with exactly the word requested, nothing else.', messages: [{ role: 'user', text: 'Reply with exactly: PONG' }] },
        signal
      )
      record('claude_subscription plain text', res.text.trim() === 'PONG', `got: ${JSON.stringify(res.text)}`)
    } catch (err) {
      record('claude_subscription plain text', false, `threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    record('claude_subscription plain text', false, 'skipped — backend unavailable')
  }

  if (codexHealth.state === 'available') {
    try {
      const res = await codex.invoke(
        { ctx: { founderUserId: 'smoke-test', threadId: 'smoke-test' }, system: 'Reply with exactly the word requested, nothing else.', messages: [{ role: 'user', text: 'Reply with exactly: PONG' }] },
        signal
      )
      record('openai_codex_subscription plain text', res.text.trim() === 'PONG', `got: ${JSON.stringify(res.text)}`)
    } catch (err) {
      record('openai_codex_subscription plain text', false, `threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    record('openai_codex_subscription plain text', false, 'skipped — backend unavailable')
  }

  // --- Tool-call round trip (synthetic ping_tool only) ---
  const toolTurnReq: ToolTurnRequest = {
    ctx: { founderUserId: 'smoke-test', threadId: 'smoke-test' },
    system: 'You are being smoke-tested.',
    messages: [{ role: 'user', content: "Call the ping_tool tool with query set to the word 'hello'." }],
    tools: [PING_TOOL],
    maxOutputTokens: 1024,
  }

  if (claudeHealth.state === 'available') {
    try {
      const res = await claude.invokeTurn(toolTurnReq, signal)
      const toolUse = res.content.find((b) => b.type === 'tool_use')
      const pass = !!toolUse && toolUse.name === 'ping_tool'
      record('claude_subscription tool-call protocol', pass, `content: ${JSON.stringify(res.content)}`)
    } catch (err) {
      record('claude_subscription tool-call protocol', false, `threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    record('claude_subscription tool-call protocol', false, 'skipped — backend unavailable')
  }

  if (codexHealth.state === 'available') {
    try {
      const res = await codex.invokeTurn(toolTurnReq, signal)
      const toolUse = res.content.find((b) => b.type === 'tool_use')
      const pass = !!toolUse && toolUse.name === 'ping_tool'
      record('openai_codex_subscription tool-call protocol', pass, `content: ${JSON.stringify(res.content)}`)
    } catch (err) {
      record('openai_codex_subscription tool-call protocol', false, `threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    record('openai_codex_subscription tool-call protocol', false, 'skipped — backend unavailable')
  }

  console.log('='.repeat(72))
  const failed = results.filter((r) => !r.pass)
  if (failed.length === 0) {
    console.log(`All ${results.length} checks passed.`)
    process.exit(0)
  } else {
    console.log(`${failed.length}/${results.length} checks FAILED:`)
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
