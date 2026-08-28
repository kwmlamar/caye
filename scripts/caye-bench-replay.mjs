#!/usr/bin/env node
// scripts/caye-bench-replay.mjs
//
// `npm run caye:bench:replay -- <fixture-id> [--model=<name>]`
//
// Runs ONE historical replay trace through current Caye's real reasoning
// (a genuine live Anthropic API call) and prints the comparison report —
// historical vs. replay, hard-invariant result, behavior deltas, proposed
// consequential actions, operator interruptions, provenance, and a
// deterministic run id.
//
// Always shells out to `vitest run lib/caye-bench/replay/cli-runner.test.ts`
// — see that file's own header comment for why: it's the ONE place
// `@/lib/supabase-server` is mocked to an isolated in-memory table, so a
// live replay run can reason for real with the live model while remaining
// structurally unable to touch real production data. This script never
// talks to Supabase, Anthropic, or anything else directly — it only sets
// the environment variables cli-runner.test.ts reads and runs vitest.
import { spawnSync } from 'node:child_process'

const KNOWN_FIXTURES = ['jeff-dworkin-draft-failure', 'mrs-max-correction-reuse', 'autumn-mcneill-redundant-notification']

function usage() {
  console.error('Usage: npm run caye:bench:replay -- <fixture-id> [--model=<name>]')
  console.error(`Known fixtures: ${KNOWN_FIXTURES.join(', ')}`)
  console.error('')
  console.error('Requires ANTHROPIC_API_KEY (a genuine live model call — this is the whole point of a replay: seeing what CURRENT Caye actually decides).')
  console.error('To see the deterministic, no-API-key pipeline self-test instead (proves the wiring, not model judgment):')
  console.error('  npx vitest run lib/caye-bench/replay/cli-runner.test.ts')
}

const args = process.argv.slice(2)
const fixture = args.find((a) => !a.startsWith('--'))
const modelArg = args.find((a) => a.startsWith('--model='))
const model = modelArg ? modelArg.slice('--model='.length) : undefined

if (!fixture) {
  usage()
  process.exit(1)
}
if (!KNOWN_FIXTURES.includes(fixture)) {
  console.error(`Unknown fixture "${fixture}".`)
  usage()
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.')
  usage()
  process.exit(1)
}

const env = {
  ...process.env,
  CAYE_BENCH_REPLAY_LIVE: '1',
  CAYE_BENCH_REPLAY_FIXTURE: fixture,
  ...(model ? { CAYE_BENCH_REPLAY_MODEL: model } : {}),
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'lib/caye-bench/replay/cli-runner.test.ts', '-t', 'runs a real replay against the live Anthropic API'],
  { stdio: 'inherit', env }
)
process.exit(result.status ?? 1)
