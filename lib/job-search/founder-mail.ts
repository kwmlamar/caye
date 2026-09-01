/**
 * Job-search response loop — outbound recruiter replies sent from the
 * founder's OWN Zoho mailbox (`founder_connected_accounts`), never a
 * customer workspace's. Mirrors the request shape of lib/email-ai.ts's
 * sendZohoReply/sendZohoEmail (same Zoho Mail REST API), but deliberately
 * does not import from lib/email-ai.ts — that module resolves credentials
 * via getZohoContext(workspaceId) against `connected_accounts`, and the
 * founder-personal isolation this migration comment establishes
 * (supabase/migrations/20260829c_founder_job_search_email.sql) is explicit
 * that founder mail must never route through the same lookup as customer
 * channels.
 */
import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { getFreshFounderZohoAccount, zohoMailBase, type FounderZohoAccount } from './founder-zoho'

export type SendFounderReplyInput = {
  applicationId: string
  to: string
  subject: string
  body: string
  /** Zoho messageId of the inbound email being replied to, if known — threads the reply instead of starting a new conversation. */
  replyToMessageId?: string | null
}

async function getActiveFounderAccount(): Promise<FounderZohoAccount> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('founder_connected_accounts')
    .select('*')
    .eq('provider', 'zoho')
    .eq('is_active', true)
    .eq('needs_reauth', false)
    .limit(1)
    .maybeSingle()
  if (error || !data) throw new Error('No active founder Zoho account connected for job-search reply sending')
  return data as FounderZohoAccount
}

/** Sends a real email as the founder to a recruiter. This is a consequential external side effect — callers must gate it (see the send_recruiter_reply admin tool). */
export async function sendFounderRecruiterReply(input: SendFounderReplyInput): Promise<{ messageId: string | null }> {
  const raw = await getActiveFounderAccount()
  const account = await getFreshFounderZohoAccount(raw)
  const base = zohoMailBase(account.metadata.zoho_api_domain)

  const url = input.replyToMessageId
    ? `${base}/api/accounts/${account.account_id}/messages/${input.replyToMessageId}`
    : `${base}/api/accounts/${account.account_id}/messages`

  const requestBody: Record<string, unknown> = {
    fromAddress: account.email_address,
    toAddress: input.to,
    subject: input.subject,
    content: input.body,
    mailFormat: 'plaintext',
  }
  if (input.replyToMessageId) requestBody.action = 'reply'

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${account.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  const data = await res.json() as { status?: { code?: number }; data?: { messageId?: string } }
  const code = data.status?.code
  if (!res.ok || (code !== 200 && code !== 201)) {
    throw new Error(`Zoho Mail send failed for job-search reply (HTTP ${res.status}, code ${code}): ${JSON.stringify(data).slice(0, 300)}`)
  }

  return { messageId: data.data?.messageId ?? null }
}
