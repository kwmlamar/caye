import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('server-only', () => ({}))

/**
 * corpus/corpus-runner.test.ts
 *
 * The entry point for `npm run caye:bench:corpus` (scripts/caye-bench-corpus.mjs
 * shells out to `vitest run` against exactly this file) AND for `npm test`'s
 * default sweep — same two mocks as `replay/cli-runner.test.ts`, same
 * safety guarantee: `@/lib/supabase-server` is ALWAYS mocked to an
 * isolated in-memory table, live mode or not, so a corpus run can never
 * reach real production data. See cli-runner.test.ts's header comment for
 * the full rationale; this file exists separately (not folded into that
 * one) because it iterates the WHOLE corpus generically rather than
 * asserting on named fixtures one at a time.
 */

vi.mock('@/lib/supabase-server', async () => {
  const { makeFakeAttentionClient } = await import('../attention-fake')
  const { attentionDouble } = await import('../attention-double')
  return {
    createServiceClient: () => makeFakeAttentionClient(attentionDouble.current),
  }
})

vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming) => modelDouble.current(client, params),
}))

import { modelDouble, liveModelRunner } from '../../model-double'
import { CORPUS } from './registry'
import { runCorpus } from './run-corpus'

const LIVE = process.env.CAYE_BENCH_CORPUS_LIVE === '1'
const OUTPUT_DIR = join(__dirname, '__output__')
const OUTPUT_PATH = join(OUTPUT_DIR, 'corpus-report.json')

function writeReport(report: unknown): void {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2))
}

describe('Caye Bench v2.5 — replay corpus', () => {
  it('every corpus entry is internally consistent (traceId agreement, no duplicates)', () => {
    const ids = CORPUS.map((e) => e.traceId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of CORPUS) expect(entry.trace.traceId).toBe(entry.traceId)
  })

  it.skipIf(!LIVE)('runs the full corpus with genuine live model reasoning (manual/CLI only)', async () => {
    const AnthropicSdk = (await import('@anthropic-ai/sdk')).default
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('CAYE_BENCH_CORPUS_LIVE=1 requires ANTHROPIC_API_KEY.')
    modelDouble.current = liveModelRunner()
    const client = new AnthropicSdk({ apiKey: process.env.ANTHROPIC_API_KEY })
    const report = await runCorpus(CORPUS, { live: true, client, model: process.env.CAYE_BENCH_REPLAY_MODEL ?? 'claude-sonnet-4-6' })
    writeReport(report)
    // eslint-disable-next-line no-console
    console.log(`Corpus (live): ${report.traceCount} traces, ${report.hardInvariantFailures} hard-invariant failures, passed=${report.passed}`)
    expect(report.hardInvariantFailures).toBe(0)
  }, 300_000)

  it('runs the full corpus deterministically (bundled turnScripts, no API key) and produces a machine-readable report', async () => {
    const report = await runCorpus(CORPUS, { generatedAt: '2026-08-28T00:00:00.000Z' })
    writeReport(report)

    expect(report.traceCount).toBe(CORPUS.length)
    expect(() => JSON.stringify(report)).not.toThrow()
    expect(report.runId).toMatch(/^[0-9a-f]{16}$/)

    for (const t of report.perTrace) {
      if (!t.passed) {
        // eslint-disable-next-line no-console
        console.error(`[corpus] ${t.traceId} FAILED — unexpected violations: ${JSON.stringify(t.unexpectedViolations)}`)
      }
    }

    // The rule the task requires: a critical (unexpected) hard-invariant
    // violation fails this run regardless of aggregate quality score.
    expect(report.hardInvariantFailures).toBe(0)
    expect(report.passed).toBe(true)
  })

  it('a corpus containing an unexpected violation fails the run (regression proof for the pass/fail gate itself)', async () => {
    // Not a real fixture — a minimal, deliberately-unsafe entry built
    // in-memory to prove runCorpus actually enforces the gate, rather
    // than trusting that "all real entries happen to pass" means the
    // gate works. Scripts the SAME low-risk, immediately-executing tool
    // (update_business_fact) twice in one turn with IDENTICAL args — a
    // real double-write the real gate (BenchInvariantGate, gate.ts,
    // unmodified) catches via idempotencyKey matching, not a violation
    // asserted by construction.
    const { sanitizeRawTrace } = await import('../sanitize')
    const trace = sanitizeRawTrace(
      {
        workspaceRawId: 'raw-ws-regression-proof',
        sourceDescription: 'Synthetic proof that runCorpus fails on an unexpected hard-invariant violation.',
        timezone: 'America/Nassau',
        businessName: 'Corpus Gate Proof',
        startTime: '2026-08-28T00:00:00.000Z',
        actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
        events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Update the pickup fact.' }],
        historicalEffects: [],
        provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident — proves the pass/fail gate.' },
      },
      { traceId: 'regression-proof-duplicate-execution', salt: 'corpus-gate-proof-salt-not-a-secret' }
    )

    const duplicateArgs = { fact_key: 'pickup_location', value: 'Main Dock' }
    const report = await runCorpus(
      [
        {
          traceId: trace.traceId,
          trace,
          categories: ['correction'],
          addedAt: '2026-08-28',
          turnScripts: {
            'evt-1': [
              { toolCalls: [{ name: 'update_business_fact', args: duplicateArgs }] },
              { toolCalls: [{ name: 'update_business_fact', args: duplicateArgs }] },
              { text: 'Updated.' },
            ],
          },
        },
      ],
      { generatedAt: '2026-08-28T00:00:00.000Z' }
    )

    expect(report.passed).toBe(false)
    expect(report.hardInvariantFailures).toBe(1)
    expect(report.perTrace[0].unexpectedViolations.map((v) => v.invariant)).toContain('duplicate_consequential_execution')
  })
})
