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

  it('an active entry with no turnScripts and no --live cannot yield a green corpus (coverage gap, not a silent skip)', async () => {
    const { sanitizeRawTrace } = await import('../sanitize')
    const trace = sanitizeRawTrace(
      {
        workspaceRawId: 'raw-ws-coverage-gap-proof',
        sourceDescription: 'Synthetic proof that an unevaluated active trace fails the corpus run.',
        timezone: 'America/Nassau',
        businessName: 'Corpus Coverage Proof',
        startTime: '2026-08-28T00:00:00.000Z',
        actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
        events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Anything.' }],
        historicalEffects: [],
        provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident — proves the coverage gate.' },
      },
      { traceId: 'coverage-gap-proof', salt: 'corpus-coverage-gap-proof-salt-not-a-secret' }
    )

    // No `turnScripts`, no `status` (defaults to 'active') — this is
    // EXACTLY the shape `npm run caye:bench:export -- save` produces
    // before this fix, except that command itself now defaults new
    // fixtures to 'pending_replay_fixture'. This test proves what
    // happens if an entry is explicitly marked (or left defaulted to)
    // 'active' without ever being wired to run.
    const report = await runCorpus([{ traceId: trace.traceId, trace, categories: ['conversation'], addedAt: '2026-08-28' }], {
      generatedAt: '2026-08-28T00:00:00.000Z',
    })

    expect(report.passed).toBe(false)
    expect(report.coverageGapCount).toBe(1)
    expect(report.coverageGapTraceIds).toEqual([trace.traceId])
    expect(report.hardInvariantFailures).toBe(0) // a coverage gap is NOT a safety failure — distinct counters
    expect(report.evaluatedCount).toBe(0)
    expect(report.perTrace[0].outcome).toBe('coverage_gap')
    expect(report.perTrace[0].passed).toBe(false)
  })

  it('a pending_replay_fixture entry is visible in the report but never blocks the run or counts as coverage', async () => {
    const { sanitizeRawTrace } = await import('../sanitize')
    const trace = sanitizeRawTrace(
      {
        workspaceRawId: 'raw-ws-pending-proof',
        sourceDescription: 'Synthetic proof that a pending_replay_fixture entry is visible but non-blocking.',
        timezone: 'America/Nassau',
        businessName: 'Corpus Pending Proof',
        startTime: '2026-08-28T00:00:00.000Z',
        actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
        events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Anything.' }],
        historicalEffects: [],
        provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident — proves the pending state.' },
      },
      { traceId: 'pending-fixture-proof', salt: 'corpus-pending-proof-salt-not-a-secret' }
    )

    const report = await runCorpus(
      [{ traceId: trace.traceId, trace, categories: ['conversation'], addedAt: '2026-08-28', status: 'pending_replay_fixture' }],
      { generatedAt: '2026-08-28T00:00:00.000Z' }
    )

    expect(report.passed).toBe(true)
    expect(report.traceCount).toBe(1)
    expect(report.activeCount).toBe(0)
    expect(report.pendingCount).toBe(1)
    expect(report.coverageGapCount).toBe(0)
    expect(report.pendingTraceIds).toEqual([trace.traceId])
    expect(report.perTrace[0].outcome).toBe('pending')
  })

  it('a narrowly-scoped knownReplayDefect does not suppress a NEW violation of the same invariant category (and the known one still reports as present)', async () => {
    // Two independent duplicate_consequential_execution violations on the
    // SAME trace, distinguished by fact_key (idempotencyKey embeds the
    // full JSON-stringified tool args — effect-helpers.ts's
    // idempotencyKeyFor — so "pickup_location" and "tour_price" each
    // produce a distinguishable violation.detail). Declaring
    // "duplicate_consequential_execution" known ONLY for pickup_location
    // must NOT suppress the tour_price one — this is the exact bug bare
    // HardInvariantId-only suppression had.
    const { sanitizeRawTrace } = await import('../sanitize')
    const trace = sanitizeRawTrace(
      {
        workspaceRawId: 'raw-ws-narrow-suppression-proof',
        sourceDescription: 'Synthetic proof that knownReplayDefects suppression is scoped to the specific known defect, not the whole invariant category.',
        timezone: 'America/Nassau',
        businessName: 'Corpus Narrow Suppression Proof',
        startTime: '2026-08-28T00:00:00.000Z',
        actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
        events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Update both facts.' }],
        historicalEffects: [],
        provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident — proves narrow known-defect matching.' },
      },
      { traceId: 'narrow-suppression-proof', salt: 'corpus-narrow-suppression-proof-salt-not-a-secret' }
    )

    const pickupArgs = { fact_key: 'pickup_location', value: 'Main Dock' }
    const priceArgs = { fact_key: 'tour_price', value: '150' }
    const report = await runCorpus(
      [
        {
          traceId: trace.traceId,
          trace,
          categories: ['correction'],
          addedAt: '2026-08-28',
          knownReplayDefects: [
            { invariant: 'duplicate_consequential_execution', detailContains: 'pickup_location', note: 'Pre-existing, tracked known issue for pickup_location double-writes.' },
          ],
          turnScripts: {
            'evt-1': [
              { toolCalls: [{ name: 'update_business_fact', args: pickupArgs }] },
              { toolCalls: [{ name: 'update_business_fact', args: pickupArgs }] },
              { toolCalls: [{ name: 'update_business_fact', args: priceArgs }] },
              { toolCalls: [{ name: 'update_business_fact', args: priceArgs }] },
              { text: 'Updated.' },
            ],
          },
        },
      ],
      { generatedAt: '2026-08-28T00:00:00.000Z' }
    )

    expect(report.passed).toBe(false)
    expect(report.hardInvariantFailures).toBe(1)
    const [trace0] = report.perTrace
    expect(trace0.unexpectedViolations.some((v) => v.invariant === 'duplicate_consequential_execution' && v.detail.includes('tour_price'))).toBe(true)
    expect(trace0.unexpectedViolations.some((v) => v.detail.includes('pickup_location'))).toBe(false)
    expect(trace0.knownDefectsStillPresent.some((v) => v.invariant === 'duplicate_consequential_execution' && v.detail.includes('pickup_location'))).toBe(true)
    expect(trace0.fixedKnownDefects.length).toBe(0)
  })

  it('a known defect that no longer reproduces is reported as fixed, not silently dropped', async () => {
    const { sanitizeRawTrace } = await import('../sanitize')
    const trace = sanitizeRawTrace(
      {
        workspaceRawId: 'raw-ws-fixed-defect-proof',
        sourceDescription: 'Synthetic proof that a knownReplayDefect no longer reproducing is reported as fixed.',
        timezone: 'America/Nassau',
        businessName: 'Corpus Fixed Defect Proof',
        startTime: '2026-08-28T00:00:00.000Z',
        actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
        events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Update the fact once.' }],
        historicalEffects: [],
        provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident — proves fixed-defect reporting.' },
      },
      { traceId: 'fixed-defect-proof', salt: 'corpus-fixed-defect-proof-salt-not-a-secret' }
    )

    // Only ONE update_business_fact call this run — the historically-known
    // double-write no longer happens, so no duplicate_consequential_execution
    // violation is produced at all.
    const report = await runCorpus(
      [
        {
          traceId: trace.traceId,
          trace,
          categories: ['correction'],
          addedAt: '2026-08-28',
          knownReplayDefects: [
            { invariant: 'duplicate_consequential_execution', detailContains: 'pickup_location', note: 'Pre-existing, tracked known issue for pickup_location double-writes.' },
          ],
          turnScripts: {
            'evt-1': [{ toolCalls: [{ name: 'update_business_fact', args: { fact_key: 'pickup_location', value: 'Main Dock' } }] }, { text: 'Updated.' }],
          },
        },
      ],
      { generatedAt: '2026-08-28T00:00:00.000Z' }
    )

    expect(report.passed).toBe(true)
    expect(report.hardInvariantFailures).toBe(0)
    expect(report.fixedKnownDefectCount).toBe(1)
    expect(report.perTrace[0].fixedKnownDefects).toEqual([
      { invariant: 'duplicate_consequential_execution', detailContains: 'pickup_location', note: 'Pre-existing, tracked known issue for pickup_location double-writes.' },
    ])
    expect(report.perTrace[0].knownDefectsStillPresent.length).toBe(0)
  })

  it('a combined report separates coverage failures from safety failures and stays machine-readable', async () => {
    const { sanitizeRawTrace } = await import('../sanitize')
    const makeTrace = (traceId: string, salt: string) =>
      sanitizeRawTrace(
        {
          workspaceRawId: `raw-ws-${traceId}`,
          sourceDescription: 'Synthetic proof that a combined report separates coverage from safety.',
          timezone: 'America/Nassau',
          businessName: 'Corpus Combined Report Proof',
          startTime: '2026-08-28T00:00:00.000Z',
          actors: [{ rawId: 'raw-operator-1', role: 'operator', displayName: 'Test Operator' }],
          events: [{ id: 'evt-1', at: '2026-08-28T00:00:00.000Z', channel: 'whatsapp', actorRawId: 'raw-operator-1', kind: 'message', text: 'Anything.' }],
          historicalEffects: [],
          provenance: { sourceSystem: 'test-fixture', notes: 'Not a real incident.' },
        },
        { traceId, salt }
      )

    const coverageGapTrace = makeTrace('combined-coverage-gap', 'combined-coverage-gap-salt')
    const pendingTrace = makeTrace('combined-pending', 'combined-pending-salt')
    const cleanTrace = makeTrace('combined-clean', 'combined-clean-salt')
    const failingTrace = makeTrace('combined-failing', 'combined-failing-salt')
    const dupArgs = { fact_key: 'pickup_location', value: 'Main Dock' }

    const report = await runCorpus(
      [
        { traceId: coverageGapTrace.traceId, trace: coverageGapTrace, categories: ['conversation'], addedAt: '2026-08-28' },
        { traceId: pendingTrace.traceId, trace: pendingTrace, categories: ['conversation'], addedAt: '2026-08-28', status: 'pending_replay_fixture' },
        {
          traceId: cleanTrace.traceId,
          trace: cleanTrace,
          categories: ['conversation'],
          addedAt: '2026-08-28',
          turnScripts: { 'evt-1': [{ text: 'Just a reply.' }] },
        },
        {
          traceId: failingTrace.traceId,
          trace: failingTrace,
          categories: ['correction'],
          addedAt: '2026-08-28',
          turnScripts: {
            'evt-1': [{ toolCalls: [{ name: 'update_business_fact', args: dupArgs }] }, { toolCalls: [{ name: 'update_business_fact', args: dupArgs }] }, { text: 'Updated.' }],
          },
        },
      ],
      { generatedAt: '2026-08-28T00:00:00.000Z' }
    )

    expect(() => JSON.stringify(report)).not.toThrow()
    expect(report.traceCount).toBe(4)
    expect(report.activeCount).toBe(3)
    expect(report.pendingCount).toBe(1)
    expect(report.evaluatedCount).toBe(2)
    expect(report.coverageGapCount).toBe(1)
    expect(report.hardInvariantFailures).toBe(1)
    // Both categories independently make the run red — neither hides the
    // other, and a report with zero of one and nonzero of the other must
    // never read as "passed".
    expect(report.passed).toBe(false)

    const byId = new Map(report.perTrace.map((t) => [t.traceId, t]))
    expect(byId.get(coverageGapTrace.traceId)?.outcome).toBe('coverage_gap')
    expect(byId.get(pendingTrace.traceId)?.outcome).toBe('pending')
    expect(byId.get(cleanTrace.traceId)?.outcome).toBe('evaluated')
    expect(byId.get(cleanTrace.traceId)?.passed).toBe(true)
    expect(byId.get(failingTrace.traceId)?.outcome).toBe('evaluated')
    expect(byId.get(failingTrace.traceId)?.passed).toBe(false)
  })
})
