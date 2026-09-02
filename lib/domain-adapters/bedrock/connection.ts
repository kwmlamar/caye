import 'server-only'

import type { BedrockConnection, BedrockConnectionResolver } from './types'

type EnvConnection = {
  workspaceId: string
  companyId: string
  supabaseUrl: string
  serviceRoleKey: string
}

/**
 * Transitional resolver for the Bedrock adapter.
 *
 * This deliberately keeps tenant mapping behind an interface so Agent 1's
 * generic domain-connection persistence can replace it without changing the
 * adapter. No workspace/company identifiers or credentials belong in code.
 */
export class EnvBedrockConnectionResolver implements BedrockConnectionResolver {
  #raw: string | undefined

  constructor(raw = process.env.BEDROCK_CONNECTIONS_JSON) {
    this.#raw = raw
  }

  async resolve(workspaceId: string): Promise<BedrockConnection | null> {
    if (!this.#raw) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(this.#raw)
    } catch {
      throw new Error('BEDROCK_CONNECTIONS_JSON is invalid JSON')
    }

    if (!Array.isArray(parsed)) {
      throw new Error('BEDROCK_CONNECTIONS_JSON must be an array')
    }

    const candidates = parsed.filter((value): value is EnvConnection => {
      if (!value || typeof value !== 'object') return false
      const item = value as Record<string, unknown>
      return item.workspaceId === workspaceId
    })

    if (candidates.length !== 1) return null

    const connection = candidates[0]
    if (
      typeof connection.companyId !== 'string' || !connection.companyId ||
      typeof connection.supabaseUrl !== 'string' || !connection.supabaseUrl ||
      typeof connection.serviceRoleKey !== 'string' || !connection.serviceRoleKey
    ) return null

    return { ...connection, workspaceId }
  }
}
