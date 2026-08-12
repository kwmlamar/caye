import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards against the failure that made this redesign necessary.
 *
 * For roughly two weeks, twelve places across the codebase asserted that
 * Lamar reviews every outreach message before it ships. All twelve were
 * false: the cron had been sending autonomously since 2026-08-12 morning.
 * Worse, one of them lived in the workspace's own system_prompt and was
 * therefore being prepended to the prompts of the very generators whose
 * output was sending itself, so the model was told it had a safety net that
 * did not exist.
 *
 * That class of drift is invisible in review — each string reads as an
 * accurate comment about a system that has since changed underneath it. So
 * it gets a test.
 *
 * If autonomy is ever genuinely rolled back, delete the offending phrase
 * from this list in the same commit that rolls it back. The list is a claim
 * about what is true, not a style rule.
 */

const BANNED_CLAIMS: readonly { phrase: string; why: string }[] = [
  { phrase: 'reviewed and sent by lamar', why: 'Caye sends outreach herself.' },
  { phrase: 'never sending anything directly', why: 'Caye sends outreach herself.' },
  { phrase: 'ships without him reading it first', why: 'Caye sends outreach herself.' },
  { phrase: 'never sends anything and never will', why: 'The autosend cron sends.' },
  { phrase: 'permanently off the table', why: 'Zero-review first touch was reversed 2026-08-12.' },
  { phrase: 'autosend is permanently locked off', why: 'autosend_enabled is true on internal_sales.' },
  { phrase: 'one allowed follow-up', why: 'The cadence is 3 touches (2 follow-ups).' },
  { phrase: 'the founder, not you, decides when', why: 'Caye discusses published price from verified facts.' },
]

/** Source we control. Excludes build output, deps, and this file. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'dist', 'build'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
    } else if (/\.(ts|tsx|md|sql)$/.test(entry) && !full.endsWith('no-stale-review-claims.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

describe('no stale human-review claims', () => {
  const root = process.cwd()
  const files = sourceFiles(root)

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  for (const { phrase, why } of BANNED_CLAIMS) {
    it(`no file claims "${phrase}" (${why})`, () => {
      const offenders = files.filter((f) =>
        readFileSync(f, 'utf8').toLowerCase().includes(phrase)
      )
      expect(
        offenders.map((f) => f.replace(root + '/', '')),
        `Stale claim "${phrase}". ${why}`
      ).toEqual([])
    })
  }
})
