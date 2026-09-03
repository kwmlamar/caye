import 'server-only'
import { createServiceClient } from './supabase-server'

/**
 * Address-level suppression for autonomous cold outreach (decisions-log
 * 2026-08-12; hardened 2026-09-03 after the bounce-rate incident — see
 * lib/outreach-kill-switch.ts's doc comment for the full story).
 *
 * lib/outreach-kill-switch.ts stops an entire workspace's sending when
 * bounces spike; this stops sending to ONE address once it's known dead,
 * so most of the send budget doesn't keep going to addresses already known
 * to bounce. Real numbers that motivated this: 2026-08-12 through
 * 2026-09-03, the system sent 251 follow-ups against only 104 first
 * touches, with zero check for whether the recipient had already bounced.
 *
 * Policy:
 *
 *   - hard bounce -> suppressed after the FIRST one. A hard bounce (5.1.1-
 *     style: unknown user, no such mailbox, domain not found) means the
 *     address is dead. There's no legitimate reason to retry a dead
 *     address, so first touch and every follow-up are blocked alike.
 *
 *   - soft bounce -> tolerated up to SOFT_BOUNCE_RETRY_LIMIT times before
 *     suppression kicks in. A soft bounce (mailbox full, greylisted,
 *     deferred) is transient by definition — the same address can
 *     legitimately succeed on a later attempt. But a repeated pattern from
 *     the same address stops looking transient and starts looking like a
 *     standing problem (a permanently full mailbox behaves exactly like a
 *     dead one from a deliverability standpoint), so it isn't retried
 *     forever either.
 *
 *   - unknown-classification bounces are never attributed to an address on
 *     their own — lib/sender-classifier.ts's extractBouncedRecipient only
 *     fills bounced_recipient when it's confident, so an "unknown" bounce
 *     with no recipient literally cannot be matched to a lead. It still
 *     counts toward the workspace-wide kill switch. Documented gap, not a
 *     silent one: a workspace could in principle have a dead address that
 *     never gets suppressed here because every bounce for it happened to
 *     be unattributable. The kill switch is the backstop for that case.
 *
 * Fails open: if the lookup itself errors (e.g. the detail columns aren't
 * deployed yet — see the migration note below), sends are NOT blocked.
 * A suppression check that can silently take down all outreach on its own
 * failure would be a worse outage than the deliverability problem it
 * exists to prevent; the kill switch remains the safety net either way.
 */

/** Soft bounces to the same address tolerated before it is suppressed too.
 *  3 gives a transient mailbox-full/greylist condition two real retries to
 *  clear on its own before Caye gives up — long enough not to punish a
 *  momentarily full inbox, short enough that a genuinely stuck address
 *  stops burning send budget and reputation. */
export const SOFT_BOUNCE_RETRY_LIMIT = 3

export type SuppressionReason = 'hard_bounce' | 'repeated_soft_bounce'

export interface SuppressionCheck {
  suppressed: boolean
  reason: SuppressionReason | null
}

const NOT_SUPPRESSED: SuppressionCheck = { suppressed: false, reason: null }

/**
 * Batch check for every candidate address in one workspace. Callers doing
 * a per-tick scan over many leads (app/api/caye/outreach-autosend-scan)
 * should call this once with the full candidate list rather than once per
 * lead — one query either way, but a single round trip instead of N.
 *
 * Keys of the returned map are lowercased/trimmed emails; look up with the
 * same normalization. An address with no bounce history at all is simply
 * absent from the map (treat that as not-suppressed).
 */
export async function getSuppressedAddresses(
  workspaceId: string,
  emails: string[]
): Promise<Map<string, SuppressionCheck>> {
  const result = new Map<string, SuppressionCheck>()
  const wanted = new Set(
    emails.map((e) => e.toLowerCase().trim()).filter((e) => e.length > 0)
  )
  if (wanted.size === 0) return result

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_outreach_bounces')
    .select('bounced_recipient, classification')
    .eq('workspace_id', workspaceId)
    .not('bounced_recipient', 'is', null)

  if (error) {
    // Detail columns (migration 20260903110000_outreach_bounce_detail_
    // suppression.sql) not deployed yet, or some other transient failure —
    // either way, fail open (see module doc comment) rather than block
    // every send in the workspace because this check itself broke.
    console.error('[outreach-suppression] lookup failed, failing open (no addresses suppressed):', error.message)
    return result
  }

  const softCounts = new Map<string, number>()
  for (const row of data ?? []) {
    const addr = String(row.bounced_recipient ?? '').toLowerCase().trim()
    if (!addr || !wanted.has(addr)) continue
    if (row.classification === 'hard') {
      result.set(addr, { suppressed: true, reason: 'hard_bounce' })
    } else if (row.classification === 'soft') {
      softCounts.set(addr, (softCounts.get(addr) ?? 0) + 1)
    }
    // 'unknown' rows carry a bounced_recipient only in the edge case where
    // extraction found an address but severity couldn't be determined —
    // deliberately not counted toward either policy branch above; treating
    // an unclassified bounce as grounds for suppression risks blocking a
    // lead on a misread, which the kill switch (workspace-wide, coarser,
    // reviewed by the founder on trip) is the safer place to absorb.
  }
  for (const [addr, count] of softCounts) {
    if (result.has(addr)) continue // already suppressed on a hard bounce
    if (count >= SOFT_BOUNCE_RETRY_LIMIT) {
      result.set(addr, { suppressed: true, reason: 'repeated_soft_bounce' })
    }
  }
  return result
}

/**
 * Single-address convenience wrapper. Prefer getSuppressedAddresses for
 * anything scanning more than one lead.
 */
export async function isAddressSuppressed(
  workspaceId: string,
  email: string
): Promise<SuppressionCheck> {
  const normalized = email.toLowerCase().trim()
  if (!normalized) return NOT_SUPPRESSED
  const map = await getSuppressedAddresses(workspaceId, [normalized])
  return map.get(normalized) ?? NOT_SUPPRESSED
}
