import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('operator tool-name leak recovery', () => {
  const source = readFileSync(join(process.cwd(), 'lib/caye-agent/execute.ts'), 'utf8')

  it('does not erase the whole operator reply when an internal tool name leaks', () => {
    expect(source).not.toContain(
      'I could not safely complete that request in this turn. No operational action was taken.'
    )
    expect(source).toContain('redactToolNameLeaks')
    expect(source).toContain("'the relevant operation'")
  })

  it('runs redaction after action grounding and persists the sanitized reply', () => {
    expect(source).toContain('applyToolNameLeakGuard(applyActionGrounding(rawReplyText))')
    expect(source).toContain("lastTurn.content = [{ type: 'text', text: replyText }]")
  })

  it('keeps the leak detector as the closed-vocabulary source of truth', () => {
    expect(source).toContain('detectToolNameLeak(sanitized, toolNames)')
    expect(source).toContain('redacted internal tool name(s) from operator reply')
  })
})
