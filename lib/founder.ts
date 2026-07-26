/**
 * Founder-role gate for the dashboard.
 *
 * Founder vs. owner:
 * - `owner` = the workspace's customer (e.g. Karenda). Locked to the operator
 *   surface — Home, Billing, Settings. Per CLAUDE.md, anything else lives in
 *   Caye-on-WhatsApp, not the dashboard.
 * - `founder` = TropiTech (Lamar). Cross-workspace power user. Sees Inbox,
 *   Bookings, Calendar, Contacts, Recent Chats, and the back-office
 *   conversation views across every workspace.
 *
 * v1 implementation: hardcoded UUID list, optionally overridden via env. The
 * proper version is a `users.is_founder` column or a roles table; until then
 * this short list keeps Karenda off the power-user routes without a migration.
 *
 * To add a founder: append their auth.users.id below OR set
 * NEXT_PUBLIC_FOUNDER_USER_IDS=uuid1,uuid2 in env.
 */

import type { NextRequest } from 'next/server'
import { createServerClient } from '@/lib/supabase-server'

const HARDCODED_FOUNDER_IDS: readonly string[] = [
  '29227a12-ca82-4796-a9c4-30ec0c6fa0e4', // classicalsineus@gmail.com (Lamar)
  '01aa7a77-5b7c-48dc-bbcb-5fcc2a1fa9b5', // kwmlamar@gmail.com (Lamar)
]

function envFounderIds(): readonly string[] {
  const raw = process.env.NEXT_PUBLIC_FOUNDER_USER_IDS
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export const FOUNDER_USER_IDS: readonly string[] = [
  ...HARDCODED_FOUNDER_IDS,
  ...envFounderIds(),
]

export function isFounderUserId(userId: string | null | undefined): boolean {
  if (!userId) return false
  return FOUNDER_USER_IDS.includes(userId)
}

/**
 * Shared founder-only route guard. Bearer JWT -> Supabase user -> checked
 * against FOUNDER_USER_IDS. Was duplicated verbatim across admin-shell,
 * caye-direct, and now coding-session routes — factored out here rather
 * than adding a fourth copy.
 */
export async function requireFounder(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return null
  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) return null
  return user
}
