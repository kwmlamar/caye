#!/usr/bin/env node
// scripts/caye-bench-corpus.mjs
//
// `npm run caye:bench:corpus [-- --live]`
//
// Runs the entire local replay corpus (lib/caye-bench/replay/corpus/registry.ts)
// and writes a machine-readable report to
// lib/caye-bench/replay/corpus/__output__/corpus-report.json (gitignored).
//
// Default mode is deterministic and needs no credentials at all — every
// hand-authored corpus entry carries its own bundled turnScripts. Pass
// --live to run every entry against a genuine Anthropic API call instead
// (requires ANTHROPIC_API_KEY); entries with no bundled script are always
// skipped in default mode and always included in --live mode.
//
// Always shells out to `vitest run` against corpus-runner.test.ts — the
// one file that mocks @/lib/supabase-server to an isolated in-memory
// table, live model or not, so a corpus run can never reach real
// production data. See that file's header comment.
//
// Exit code mirrors vitest's: a critical hard-invariant violation on any
// entry fails the corpus run (non-zero exit) regardless of aggregate
// quality score.
import { spawnSync } from 'node:child_process'

const live = process.argv.includes('--live')

if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error('--live requires ANTHROPIC_API_KEY to be set.')
  process.exit(1)
}

const env = { ...process.env, ...(live ? { CAYE_BENCH_CORPUS_LIVE: '1' } : {}) }

const testNamePattern = live
  ? 'runs the full corpus with genuine live model reasoning'
  : 'runs the full corpus deterministically'

const result = spawnSync('npx', ['vitest', 'run', 'lib/caye-bench/replay/corpus/corpus-runner.test.ts', '-t', testNamePattern, '--reporter=verbose'], {
  stdio: 'inherit',
  env,
})
process.exit(result.status ?? 1)
