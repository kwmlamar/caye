import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * Resolve an authoritative workspace implied by canonical entities linked to
 * a founder Direct thread. Today property is the first authoritative subject
 * type: a property belongs to exactly one workspace, so dashboard selection
 * must never move that thread into a different tenant.
 *
 * Return null when the thread has no authoritative linked subject; ordinary
 * founder threads may then use the dashboard's explicit workspace context.
 * Fail closed if a linked canonical subject is stale or if authoritative
 * subjects disagree about workspace.
 */
export async function resolveAuthoritativeThreadWorkspace(
  supabase: SupabaseClient,
  threadId: string
): Promise<string | null> {
  const { data: links, error: linksError } = await supabase
    .from('caye_direct_thread_entities')
    .select('subject_type, subject_id')
    .eq('thread_id', threadId)

  if (linksError) {
    throw new Error(`[caye-direct-thread-scope] entity lookup failed: ${linksError.message}`)
  }

  const propertyIds = (links ?? [])
    .filter((link) => link.subject_type === 'property')
    .map((link) => link.subject_id as string)

  if (propertyIds.length === 0) return null

  const uniquePropertyIds = [...new Set(propertyIds)]
  const { data: properties, error: propertyError } = await supabase
    .from('physical_properties')
    .select('id, workspace_id')
    .in('id', uniquePropertyIds)

  if (propertyError) {
    throw new Error(`[caye-direct-thread-scope] property lookup failed: ${propertyError.message}`)
  }
  if ((properties ?? []).length !== uniquePropertyIds.length) {
    throw new Error('Thread has a stale property link')
  }

  const workspaceIds = [...new Set((properties ?? []).map((property) => property.workspace_id as string))]
  if (workspaceIds.length !== 1) {
    throw new Error('Thread authoritative subjects span multiple workspaces')
  }

  return workspaceIds[0]
}
