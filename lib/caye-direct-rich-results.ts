import { enforceActionGrounding } from '@/lib/caye-agent/action-claim-guard'

/** Safe, semantic result data for Caye Direct. Never contains executable UI. */
export type RichResultBlock =
  | { type: 'metric'; label: string; value: string; detail?: string; resolved?: Record<string, string> }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'code_diff'; language?: string; before: string; after: string }
  | { type: 'goal_reference'; id: string; resolved?: Record<string, string> }
  | { type: 'work_reference'; id: string; resolved?: Record<string, string> }
  | { type: 'artifact_reference'; id: string; name: string; mimeType?: string }
  | { type: 'engineering_artifact'; artifactId: string }
  | { type: 'business_artifact'; artifactId: string }

export interface ArtifactReference { id: string; name: string; mimeType?: string }
export interface RichResultProvenance {
  requestedMode?: string
  selectedBackend?: string
  provider?: string
  model?: string
  fallbackSequence?: { backend: string; reason: string }[]
  latencyMs?: number
  usage?: { inputTokens?: number; outputTokens?: number }
}
export interface RichResult {
  version: 1
  narrative: string
  blocks: RichResultBlock[]
  artifacts?: ArtifactReference[]
  provenance?: RichResultProvenance
}

const MAX_NARRATIVE = 20_000
const MAX_BLOCKS = 24
const MAX_TEXT = 12_000
const MAX_ROWS = 100
const MAX_COLUMNS = 16
const idOk = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const text = (value: unknown, max = MAX_TEXT) => typeof value === 'string' && value.length <= max ? value : null

/** Returns null for malformed or unknown data: callers keep narrative-only output. */
export function validateRichResult(value: unknown): RichResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const narrative = text(raw.narrative, MAX_NARRATIVE)
  if (raw.version !== 1 || narrative === null || !Array.isArray(raw.blocks) || raw.blocks.length > MAX_BLOCKS) return null

  const blocks: RichResultBlock[] = []
  for (const item of raw.blocks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const b = item as Record<string, unknown>

    if (b.type === 'metric') {
      const label = text(b.label, 160)
      const value = text(b.value, 240)
      const detail = b.detail === undefined ? undefined : text(b.detail, 600)
      if (!label || !value || detail === null) return null
      blocks.push({ type: 'metric', label, value, ...(detail ? { detail } : {}) })
      continue
    }

    if (b.type === 'table') {
      if (!Array.isArray(b.columns) || !Array.isArray(b.rows) || b.columns.length > MAX_COLUMNS || b.rows.length > MAX_ROWS) return null
      const columns = b.columns.map((x) => text(x, 160))
      const rows = b.rows.map((r) => Array.isArray(r) && r.length === columns.length ? r.map((x) => text(x, 1000)) : null)
      if (columns.some((x) => x === null) || rows.some((r) => !r || r.some((x) => x === null))) return null
      blocks.push({ type: 'table', columns: columns as string[], rows: rows as string[][] })
      continue
    }

    if (b.type === 'code') {
      const code = text(b.code)
      const language = b.language === undefined ? undefined : text(b.language, 64)
      if (!code || language === null) return null
      blocks.push({ type: 'code', code, ...(language ? { language } : {}) })
      continue
    }

    if (b.type === 'code_diff') {
      const before = text(b.before)
      const after = text(b.after)
      const language = b.language === undefined ? undefined : text(b.language, 64)
      if (!before || !after || language === null) return null
      blocks.push({ type: 'code_diff', before, after, ...(language ? { language } : {}) })
      continue
    }

    if ((b.type === 'goal_reference' || b.type === 'work_reference') && idOk(b.id)) {
      blocks.push({ type: b.type, id: b.id as string })
      continue
    }

    if (b.type === 'artifact_reference' && idOk(b.id)) {
      const name = text(b.name, 240)
      const mimeType = b.mimeType === undefined ? undefined : text(b.mimeType, 128)
      if (!name || mimeType === null || 'url' in b) return null
      blocks.push({ type: 'artifact_reference', id: b.id as string, name, ...(mimeType ? { mimeType } : {}) })
      continue
    }
    // Only server orchestration can introduce these trusted semantic blocks
    // — never accepted from model-authored fenced JSON (extractRichResult).
    if (b.type === 'engineering_artifact' || b.type === 'business_artifact') return null

    return null
  }

  // Rich blocks are presentation, not an alternate route around action-claim
  // grounding. V1 therefore rejects any structured block text that would be
  // considered an ungrounded completion claim with no tool evidence. A truly
  // completed action can still be reported in the normal grounded narrative.
  const displayText = JSON.stringify(blocks)
  if (enforceActionGrounding(displayText, []).violations.length > 0) return null

  return { version: 1, narrative, blocks }
}

/**
 * Models may place the rich envelope in a fenced block after normal prose.
 * We inspect all fences and accept exactly one block that validates as a
 * RichResult. Ordinary markdown/code fences are ignored rather than being
 * mistaken for UI data. Plain text remains fully compatible.
 */
export function extractRichResult(textValue: string): { narrative: string; result?: RichResult } {
  const candidates: RichResult[] = []
  for (const match of textValue.matchAll(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g)) {
    try {
      const parsed = validateRichResult(JSON.parse(match[1]))
      if (parsed) candidates.push(parsed)
    } catch {
      // Ordinary code/markdown fence; not a rich result.
    }
  }
  return candidates.length === 1
    ? { narrative: candidates[0].narrative, result: candidates[0] }
    : { narrative: textValue }
}
