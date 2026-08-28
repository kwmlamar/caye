#!/usr/bin/env node
// scripts/caye-bench-export.mjs
//
// The capture workflow, as two explicit, separate steps so raw production
// information can never land in a commit from a single command:
//
//   npm run caye:bench:export -- preview \
//     --episode=conversation --workspace=<real workspace id> --conversation=<real conversation id> \
//     --trace-id=<slug> --description="<non-identifying failure-mode summary>"
//
//   # ...review the printed .caye-bench-export-tmp/<slug>.preview.json by hand...
//
//   npm run caye:bench:export -- save \
//     --from=.caye-bench-export-tmp/<slug>.preview.json --name=<fixture-name> \
//     --categories=conversation,correction [--incident-refs=CAY-123] \
//     [--known-defects=fabricated_action_or_result::draft_in_inbox --known-defect-note="..."]
//
// A freshly saved fixture starts status: pending_replay_fixture — it does
// NOT count as corpus coverage or fail the corpus run — until turnScripts
// are added and its status is flipped to "active" in registry.ts (or the
// fixture JSON itself). An "active" entry with no turnScripts fails the
// corpus run as a distinct coverage gap, by design.
//
// `preview` requires real Supabase credentials (NEXT_PUBLIC_SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY) — it is the ONLY step that touches production.
// `save` needs none — it only reads the local preview file, re-verifies
// it, and writes into the tracked lib/caye-bench/replay/fixtures/production/
// directory. Both shell out to `vitest run` against the corresponding
// *-runner.test.ts file so the real sanitizer/verifier code runs, not a
// second, driftable copy of it in this script.
import { spawnSync } from 'node:child_process'

function parseArgs(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (match) flags[match[1]] = match[2] ?? 'true'
  }
  return flags
}

function usage() {
  console.error('Usage:')
  console.error('  npm run caye:bench:export -- preview --episode=<kind> --workspace=<id> [episode-specific ids] --trace-id=<slug> --description="<summary>"')
  console.error(
    '  npm run caye:bench:export -- save --from=<preview-file> --name=<fixture-name> --categories=<a,b,c> [--incident-refs=<a,b>] ' +
      '[--known-defects=<invariant::detail-substring,...> --known-defect-note="..."]'
  )
  console.error('')
  console.error('Episode kinds: conversation, booking, correction, consequential-action, proactive-notification, artifact, time-window')
  console.error('Episode-specific id flags: --conversation=, --booking=, --source-message=, --request-id=, --attention-item=, --artifact=, --start-at= --end-at=')
}

const [subcommand, ...rest] = process.argv.slice(2)
const flags = parseArgs(rest)

if (subcommand === 'preview') {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('preview requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — this step reads real production data.')
    process.exit(1)
  }
  const { episode, workspace, 'trace-id': traceId, description } = flags
  if (!episode || !workspace || !traceId || !description) {
    console.error('preview requires --episode, --workspace, --trace-id, and --description.')
    usage()
    process.exit(1)
  }

  const selector = { kind: episode, workspaceId: workspace }
  const idFlagByKind = {
    conversation: ['conversation', 'conversationId'],
    booking: ['booking', 'bookingId'],
    correction: ['source-message', 'sourceMessageId'],
    'consequential-action': ['request-id', 'requestId'],
    'proactive-notification': ['attention-item', 'attentionItemId'],
    artifact: ['artifact', 'artifactId'],
  }
  if (episode === 'time-window') {
    if (!flags['start-at'] || !flags['end-at']) {
      console.error('time-window episodes require --start-at and --end-at (ISO timestamps).')
      process.exit(1)
    }
    selector.startAt = flags['start-at']
    selector.endAt = flags['end-at']
  } else {
    const mapping = idFlagByKind[episode]
    if (!mapping) {
      console.error(`Unknown episode kind "${episode}".`)
      usage()
      process.exit(1)
    }
    const [flagName, jsonKey] = mapping
    if (!flags[flagName]) {
      console.error(`Episode kind "${episode}" requires --${flagName}.`)
      process.exit(1)
    }
    selector[jsonKey] = flags[flagName]
  }

  const env = {
    ...process.env,
    CAYE_BENCH_EXPORT_LIVE: '1',
    CAYE_BENCH_EXPORT_SELECTOR: JSON.stringify(selector),
    CAYE_BENCH_EXPORT_TRACE_ID: traceId,
    CAYE_BENCH_EXPORT_DESCRIPTION: description,
  }
  const result = spawnSync('npx', ['vitest', 'run', 'lib/caye-bench/export/export-runner.test.ts', '--reporter=verbose'], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
} else if (subcommand === 'save') {
  const { from, name, categories, 'incident-refs': incidentRefs, 'known-defects': knownDefects, 'known-defect-note': knownDefectNote } = flags
  if (!from || !name || !categories) {
    console.error('save requires --from, --name, and --categories.')
    usage()
    process.exit(1)
  }
  const env = {
    ...process.env,
    CAYE_BENCH_EXPORT_SAVE: '1',
    CAYE_BENCH_EXPORT_FROM: from,
    CAYE_BENCH_EXPORT_SAVE_NAME: name,
    CAYE_BENCH_EXPORT_CATEGORIES: categories,
    ...(incidentRefs ? { CAYE_BENCH_EXPORT_INCIDENT_REFS: incidentRefs } : {}),
    ...(knownDefects ? { CAYE_BENCH_EXPORT_KNOWN_DEFECTS: knownDefects } : {}),
    ...(knownDefectNote ? { CAYE_BENCH_EXPORT_KNOWN_DEFECT_NOTE: knownDefectNote } : {}),
  }
  const result = spawnSync('npx', ['vitest', 'run', 'lib/caye-bench/export/save-runner.test.ts', '--reporter=verbose'], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
} else {
  usage()
  process.exit(1)
}
