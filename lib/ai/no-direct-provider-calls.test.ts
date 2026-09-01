import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Structural guard. The provider-independence work is only durable if the
 * next feature cannot quietly re-couple Caye to one vendor — and the easiest
 * way to do that is `new Anthropic()` in a new file, which nothing else in CI
 * would notice.
 *
 * Runtime provider SDK usage is allowed ONLY inside a provider adapter.
 * Type-only imports are fine: they have no runtime footprint and cannot fail
 * when a vendor is down.
 */
const ROOTS = ['app', 'lib', 'components', 'scripts']

/**
 * Adapters, by design. Each is fronted by a router that can route around it:
 *  - lib/ai/providers/*        the gateway's own adapters
 *  - lib/research/anthropic.ts + providers/anthropic.ts
 *      Anthropic's *server-side* web search/fetch tools, which the gateway's
 *      chat-completion contract does not model. lib/research/providers/router.ts
 *      falls over to the OpenAI and OpenRouter research adapters.
 */
const ADAPTER_ALLOWLIST = [
  'lib/ai/providers/anthropic.ts',
  'lib/ai/providers/openai-compatible.ts',
  'lib/research/anthropic.ts',
  'lib/research/providers/anthropic.ts',
  'lib/research/providers/openai.ts',
  'lib/research/providers/openrouter.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

const FILES = ROOTS.flatMap((root) => walk(root)).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

describe('no direct provider coupling outside adapters', () => {
  it('constructs a vendor SDK client only inside an adapter', () => {
    const offenders = FILES.filter(
      (f) => /new Anthropic\s*\(|new OpenAI\s*\(/.test(f.text) && !ADAPTER_ALLOWLIST.includes(f.path)
    ).map((f) => f.path)

    expect(offenders, 'construct AI calls through lib/ai (or lib/llm-telemetry) instead').toEqual([])
  })

  it('imports a vendor SDK at runtime only inside an adapter', () => {
    const offenders = FILES.filter(
      (f) => /^import (?!type )[^\n]*from '@anthropic-ai\/sdk'/m.test(f.text) && !ADAPTER_ALLOWLIST.includes(f.path)
    ).map((f) => f.path)

    expect(offenders, 'use `import type Anthropic` — feature code must not hold a vendor client').toEqual([])
  })

  it('never calls messages.create outside an adapter', () => {
    const offenders = FILES.filter(
      (f) => /\bmessages\.create\s*\(/.test(f.text) && !ADAPTER_ALLOWLIST.includes(f.path) && !f.path.includes('caye-bench')
    ).map((f) => f.path)

    expect(offenders).toEqual([])
  })

  it('reads a provider API key only inside an adapter or the gateway config', () => {
    const allowed = [
      ...ADAPTER_ALLOWLIST,
      'lib/ai/models.ts',
      // Spawns an isolated coding sandbox with its own separately-provisioned
      // key; not a Caye AI call path.
      'lib/coding-session/boot.ts',
      // Declares availability for the founder model picker; never calls out.
      'lib/model-router/backends/anthropic-api.ts',
      // Local dev proof scripts: they only log whether a key is present in
      // the parent env, to show that a subprocess backend did not inherit it.
      'scripts/model-router-real-tool-proof.ts',
      'scripts/model-router-real-tool-proof-hardened.ts',
    ]
    const offenders = FILES.filter(
      (f) => /process\.env\.ANTHROPIC_API_KEY/.test(f.text) && !allowed.includes(f.path)
    ).map((f) => f.path)

    expect(offenders).toEqual([])
  })
})

describe('no streaming AI call sites', () => {
  /**
   * Caye has no streaming model calls today. The gateway therefore has no
   * mid-stream fallback problem to solve. This guard makes that an explicit,
   * enforced fact: the day someone adds `stream: true`, this fails and the
   * partial-output failover rules have to be designed before it ships.
   */
  it('nothing requests a streamed completion', () => {
    const offenders = FILES.filter(
      (f) => /stream:\s*true/.test(f.text) || /\.messages\.stream\s*\(/.test(f.text)
    ).map((f) => f.path)

    expect(
      offenders,
      'streaming needs mid-stream fallback rules in lib/ai/gateway.ts before it can ship'
    ).toEqual([])
  })
})
