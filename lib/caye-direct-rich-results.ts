/** Safe, semantic result data for Caye Direct. Never contains executable UI. */
export type RichResultBlock =
  | { type: 'metric'; label: string; value: string; detail?: string; resolved?: Record<string, string> }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'code_diff'; language?: string; before: string; after: string }
  | { type: 'goal_reference'; id: string; resolved?: Record<string, string> }
  | { type: 'work_reference'; id: string; resolved?: Record<string, string> }
  | { type: 'artifact_reference'; id: string; name: string; url?: string; mimeType?: string }

export interface ArtifactReference { id: string; name: string; url?: string; mimeType?: string }
export interface RichResultProvenance {
  requestedMode?: string; selectedBackend?: string; provider?: string; model?: string
  fallbackSequence?: { backend: string; reason: string }[]; latencyMs?: number
  usage?: { inputTokens?: number; outputTokens?: number }
}
export interface RichResult { version: 1; narrative: string; blocks: RichResultBlock[]; artifacts?: ArtifactReference[]; provenance?: RichResultProvenance }

const MAX_NARRATIVE = 20_000, MAX_BLOCKS = 24, MAX_TEXT = 12_000, MAX_ROWS = 100, MAX_COLUMNS = 16
const idOk = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const text = (value: unknown, max = MAX_TEXT) => typeof value === 'string' && value.length <= max ? value : null
const url = (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= 2048 && /^https:\/\//.test(value))

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
    if (b.type === 'metric') { const label = text(b.label, 160), value = text(b.value, 240), detail = b.detail === undefined ? undefined : text(b.detail, 600); if (!label || !value || detail === null) return null; blocks.push({ type: 'metric', label, value, ...(detail ? { detail } : {}) }); continue }
    if (b.type === 'table') { if (!Array.isArray(b.columns) || !Array.isArray(b.rows) || b.columns.length > MAX_COLUMNS || b.rows.length > MAX_ROWS) return null; const columns = b.columns.map(x => text(x, 160)); const rows = b.rows.map(r => Array.isArray(r) && r.length === columns.length ? r.map(x => text(x, 1000)) : null); if (columns.some(x => x === null) || rows.some(r => !r || r.some(x => x === null))) return null; blocks.push({ type: 'table', columns: columns as string[], rows: rows as string[][] }); continue }
    if (b.type === 'code') { const code = text(b.code), language = b.language === undefined ? undefined : text(b.language, 64); if (!code || language === null) return null; blocks.push({ type: 'code', code, ...(language ? { language } : {}) }); continue }
    if (b.type === 'code_diff') { const before = text(b.before), after = text(b.after), language = b.language === undefined ? undefined : text(b.language, 64); if (!before || !after || language === null) return null; blocks.push({ type: 'code_diff', before, after, ...(language ? { language } : {}) }); continue }
    if ((b.type === 'goal_reference' || b.type === 'work_reference') && idOk(b.id)) { blocks.push({ type: b.type, id: b.id as string }); continue }
    if (b.type === 'artifact_reference' && idOk(b.id)) { const name = text(b.name, 240), mimeType = b.mimeType === undefined ? undefined : text(b.mimeType, 128); if (!name || !url(b.url) || mimeType === null) return null; blocks.push({ type: 'artifact_reference', id: b.id as string, name, ...(typeof b.url === 'string' ? { url: b.url } : {}), ...(mimeType ? { mimeType } : {}) }); continue }
    return null
  }
  return { version: 1, narrative, blocks }
}

/** Models may put a rich envelope in a fenced JSON block; plaintext stays compatible. */
export function extractRichResult(textValue: string): { narrative: string; result?: RichResult } {
  const match = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (!match) return { narrative: textValue }
  try { const result = validateRichResult(JSON.parse(match[1])); return result ? { narrative: result.narrative, result } : { narrative: textValue } } catch { return { narrative: textValue } }
}
