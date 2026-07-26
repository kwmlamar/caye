import 'server-only'

/**
 * Maps NDJSON lines from `claude -p --output-format stream-json --verbose`
 * into rows for caye_coding_session_messages.
 *
 * The exact event shape (assistant/user/system/result, each wrapping an
 * Anthropic Messages-API-shaped `message`) is documented Claude Code CLI
 * behavior, but this was written before an empirical run against the real
 * CLI (see the plan's Phase 0 spike) — written defensively so an
 * unrecognized `type` falls through to a generic `system` row instead of
 * being silently dropped. Revisit once Phase 0 confirms the real shape.
 */

export type MessageKind =
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'file_edit'
  | 'commit'
  | 'system'
  | 'error'
  | 'summary'

export interface ParsedMessage {
  kind: MessageKind
  body: string
  raw: unknown
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + '… [truncated]' : s
}

function isGitCommitCommand(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const cmd = (input as Record<string, unknown>).command
  return typeof cmd === 'string' && /\bgit\s+commit\b/.test(cmd)
}

/** Parses one already-JSON.parse'd stream-json event into zero or more rows. */
function parseEvent(event: Record<string, unknown>): ParsedMessage[] {
  const type = event.type

  if (type === 'assistant' || type === 'user') {
    const message = event.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? message!.content : []
    const rows: ParsedMessage[] = []

    for (const block of content as Record<string, unknown>[]) {
      const blockType = block.type

      if (blockType === 'text' && typeof block.text === 'string' && block.text.trim()) {
        rows.push({ kind: 'assistant_text', body: truncate(block.text), raw: block })
        continue
      }

      if (blockType === 'tool_use') {
        const name = String(block.name ?? 'unknown_tool')
        if (FILE_EDIT_TOOLS.has(name)) {
          const path = (block.input as Record<string, unknown> | undefined)?.file_path ?? ''
          rows.push({ kind: 'file_edit', body: `${name}: ${path}`, raw: block })
        } else if (name === 'Bash' && isGitCommitCommand(block.input)) {
          const cmd = (block.input as Record<string, unknown>).command
          rows.push({ kind: 'commit', body: truncate(String(cmd)), raw: block })
        } else {
          rows.push({ kind: 'tool_call', body: `${name}(${truncate(JSON.stringify(block.input ?? {}), 300)})`, raw: block })
        }
        continue
      }

      if (blockType === 'tool_result') {
        const raw = block.content
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
        rows.push({ kind: 'tool_result', body: truncate(text), raw: block })
        continue
      }
      // Unrecognized block within a recognized event — keep, don't drop.
      rows.push({ kind: 'system', body: truncate(JSON.stringify(block)), raw: block })
    }
    return rows
  }

  if (type === 'result') {
    const text = typeof event.result === 'string' ? event.result : JSON.stringify(event)
    return [{ kind: 'summary', body: truncate(text), raw: event }]
  }

  if (type === 'system') {
    return [{ kind: 'system', body: truncate(JSON.stringify(event)), raw: event }]
  }

  // Anything unrecognized: surface it rather than swallow it.
  return [{ kind: 'system', body: truncate(JSON.stringify(event)), raw: event }]
}

/**
 * Parses complete NDJSON lines (already split by the caller) into rows.
 * Malformed lines produce an `error` row rather than throwing, so one bad
 * line from a partially-written file doesn't kill the whole poll tick.
 */
export function parseStreamJsonLines(lines: string[]): ParsedMessage[] {
  const rows: ParsedMessage[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      rows.push(...parseEvent(event))
    } catch {
      rows.push({ kind: 'error', body: `Unparseable output line: ${truncate(trimmed, 300)}`, raw: trimmed })
    }
  }
  return rows
}
