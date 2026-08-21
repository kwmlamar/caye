import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A static invariant, not a behaviour test.
 *
 * The stated rule is: no internal implementation detail may reach WhatsApp,
 * Caye Direct, email, SMS, or any other owner-facing channel. Every instance
 * found so far — "[operator_reminder]", "[tool_use: …]", "[image]",
 * "[b2b_partnership]", "NOTHING_TO_REPORT" — was the same move: a template
 * literal wrapping an internal identifier, written into a column a human
 * later reads.
 *
 * Fixing instances does not close a class. This scans the source for the
 * shape itself, so the NEXT one fails here rather than in a customer's
 * thread. It is deliberately blunt: if you genuinely need `[${x}]` in
 * operator-facing text, you almost certainly want a renderer like
 * mediaPlaceholder() instead, and if you truly don't, add the file to
 * ALLOWED with a reason.
 */

const ROOTS = ['lib', 'app']
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__snapshots__'])

/**
 * Files permitted to contain the shape. Each needs a reason, and none may be
 * a path that writes owner-facing text.
 */
const ALLOWED = new Map<string, string>([
  // The audit column deliberately keeps markers; isInternalTurnBody hides
  // those rows from every human-facing render, and visibleBody strips them
  // as a backstop. See lib/caye-operator-messages.ts.
  ['lib/caye-operator-messages.ts', 'audit-only marker rendering, filtered before display'],
  // A regex character class, not text: `[${ZW[0]}${ZW[1]}]{128}$` matches the
  // zero-width signup-code run. Nothing is rendered.
  ['lib/onboarding-whatsapp.ts', 'regex character class, not output'],
  // Deterministic hashing for the tool-call dedupe key. Never displayed.
  ['lib/caye-agent/orchestrator.ts', 'stableStringify hash input, not output'],
  // console.log diagnostics only.
  ['lib/zoho-calendar.ts', 'console diagnostics only'],
  // Numbered list inside an LLM prompt, reading the owner's own sent mail.
  // The indices are prompt scaffolding, never echoed to a human.
  ['app/api/caye/discovery/route.ts', 'prompt-internal numbering'],
  ['lib/business-fact-semantic-match.ts', 'prompt-internal candidate ids'],
  ['lib/business-fact-conflict.ts', 'prompt-internal candidate ids'],
  // Placeholder for an unrenderable content-block type inside a CLI
  // subprocess prompt (Claude/Codex subscription backends) — never shown
  // to a human, only ever read by the reasoning backend itself.
  ['lib/model-router/tool-bridge/render-transcript.ts', 'CLI prompt scaffolding, not owner-facing output'],
  // Array-index path segment in a schema-validation error, fed back to the
  // MODEL as a tool_result so it can correct its own malformed tool call —
  // same category as orchestrator.ts's stableStringify entry above.
  ['lib/model-router/tool-bridge/schema-validate.ts', 'validation error path returned to the model, not a human'],
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Strip // and block comments so prose about the bug isn't a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('no internal identifiers interpolated into owner-facing strings', () => {
  it('finds no `[${...}]` template literals outside the allowlist', () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = file.replace(/\\/g, '/')
        if (ALLOWED.has(rel)) continue
        const code = stripComments(readFileSync(file, 'utf8'))
        // `[${kind}]` / `[${message.type}]` / `[${x} message]` — an internal
        // value wrapped in brackets inside a template literal.
        const re = /`[^`]*\[\$\{[^}]+\}[^`]*\]/g
        for (const match of code.match(re) ?? []) {
          offenders.push(`${rel}: ${match.trim().slice(0, 90)}`)
        }
      }
    }

    expect(
      offenders,
      offenders.length
        ? `Bracketed internal identifiers in template literals:\n${offenders.join('\n')}\n\nUse a renderer (e.g. mediaPlaceholder) or add to ALLOWED with a reason.`
        : ''
    ).toEqual([])
  })

  it('finds no source writing the quiet-scan sentinel into a body/preview field', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = file.replace(/\\/g, '/')
        // quiet-scan.ts owns the token; everything else must go through it.
        if (rel === 'lib/quiet-scan.ts') continue
        const code = stripComments(readFileSync(file, 'utf8'))
        if (/['"`]NOTHING_TO_REPORT/.test(code)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
