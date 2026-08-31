import { createHash } from 'node:crypto'

export type IntelligenceScope =
  | { kind: 'global'; workspaceId?: never }
  | { kind: 'operator'; workspaceId?: never }
  | { kind: 'workspace'; workspaceId: string }

export type EpistemicType = 'observed_source_fact'|'source_claim'|'corroborated_claim'|'inference'|'prediction'|'recommendation'|'unknown'

export function normalizeIntelligenceStatement(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function intelligenceSemanticKey(input: { domain: string; topic: string; claim: string }): string {
  const canonical = [input.domain, input.topic, normalizeIntelligenceStatement(input.claim)].join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

export function assertIntelligenceScope(scope: IntelligenceScope): void {
  if (scope.kind === 'workspace' && !scope.workspaceId?.trim()) throw new Error('workspace scope requires workspaceId')
}

export function scopeKey(scope: IntelligenceScope): string {
  assertIntelligenceScope(scope)
  return scope.kind === 'workspace' ? `workspace:${scope.workspaceId}` : scope.kind
}
