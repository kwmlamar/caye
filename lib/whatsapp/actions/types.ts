import 'server-only'

export interface ActionContext {
  workspaceId: string
}

export interface ActionResult {
  /** Short ack body to queue back to the operator on WhatsApp. Empty = stay silent. */
  ackBody: string
  /** Optional structured tag for the multi-summary composer. */
  tag?: { label: string; status: 'ok' | 'skipped' | 'failed' }
}
