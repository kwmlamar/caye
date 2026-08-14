import { describe, expect, it, vi } from 'vitest'
import { deliverStaleSalesHoldRecovery, type StaleHoldRecoveryDriver } from './stale-hold-recovery'

function driver(overrides: Partial<StaleHoldRecoveryDriver> = {}) {
  const calls: string[] = []
  const value: StaleHoldRecoveryDriver = {
    generate: vi.fn(async () => ({ action: 'reply' as const, content: 'Canonical answer' })),
    block: vi.fn(async () => { calls.push('block') }),
    prepare: vi.fn(async () => { calls.push('prepare') }),
    send: vi.fn(async () => { calls.push('send'); return { messageId: 'zoho-1' } }),
    complete: vi.fn(async () => { calls.push('complete'); return 'sent' as const }),
    markUnknown: vi.fn(async () => { calls.push('unknown') }),
    ...overrides,
  }
  return { value, calls }
}

describe('stale Sales hold recovery delivery', () => {
  it('persists before using the canonical sender, then completes', async () => {
    const { value, calls } = driver()
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question', () => '2026-08-14T12:00:00Z')).resolves.toBe('sent')
    expect(calls).toEqual(['prepare', 'send', 'complete'])
    expect(value.send).toHaveBeenCalledWith('Canonical answer')
    expect(value.complete).toHaveBeenCalledWith('2026-08-14T12:00:00Z', 'zoho-1')
  })

  it('keeps the existing hold on generation failure', async () => {
    const { value, calls } = driver({ generate: vi.fn(async () => { throw new Error('model unavailable') }) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('blocked')
    expect(calls).toEqual(['block'])
    expect(value.prepare).not.toHaveBeenCalled()
    expect(value.send).not.toHaveBeenCalled()
  })

  it('does not send when the canonical Sales path holds or ignores the inbound', async () => {
    const { value, calls } = driver({ generate: vi.fn(async () => ({ action: 'hold' as const, reason: 'needs evidence' })) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('blocked')
    expect(calls).toEqual(['block'])
  })

  it('fails closed after an uncertain provider result and never completes', async () => {
    const { value, calls } = driver({ send: vi.fn(async () => { throw new Error('network reset') }) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('delivery_unknown')
    expect(calls).toEqual(['prepare', 'unknown'])
    expect(value.complete).not.toHaveBeenCalled()
  })

  it('treats a provider success without a durable message id as uncertain', async () => {
    const { value, calls } = driver({ send: vi.fn(async () => ({ messageId: null })) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('delivery_unknown')
    expect(calls).toEqual(['prepare', 'unknown'])
    expect(value.complete).not.toHaveBeenCalled()
  })

  it('does not make a second send when final completion fails after provider success', async () => {
    const { value, calls } = driver({ complete: vi.fn(async () => { throw new Error('database unavailable') }) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('delivery_unknown')
    expect(calls).toEqual(['prepare', 'send', 'unknown'])
    expect(value.send).toHaveBeenCalledTimes(1)
  })

  it('does not send when outbound persistence fails', async () => {
    const { value, calls } = driver({ prepare: vi.fn(async () => { throw new Error('write failed') }) })
    await expect(deliverStaleSalesHoldRecovery(value, 'Re: Question')).resolves.toBe('blocked')
    expect(calls).toEqual(['block'])
    expect(value.send).not.toHaveBeenCalled()
  })
})

describe('stale Sales hold recovery migration contract', () => {
  async function migration() {
    return import('node:fs/promises').then(fs => fs.readFile(
      new URL('../../supabase/migrations/20260814210000_sales_stale_hold_recovery.sql', import.meta.url), 'utf8'))
  }

  it('uses a receipt keyed to the original inbound and service-only RPCs', async () => {
    const sql = await migration()
    expect(sql).toContain('unique (original_message_id)')
    expect(sql).toContain("'already_' || v_existing.status")
    expect(sql).toContain("role in ('owner', 'founder')")
    expect(sql).toContain("v_conversation.human_agent_reason <> 'quote_without_database_price'")
    expect(sql).toContain("status = 'delivery_attempting'")
    expect(sql).toContain("status = 'delivery_unknown'")
    const prepare = sql.slice(sql.indexOf('sales_prepare_stale_hold_recovery_delivery'), sql.indexOf('sales_mark_stale_hold_recovery_unknown'))
    expect(prepare.indexOf('recovery was superseded before delivery')).toBeGreaterThan(-1)
    expect(prepare.indexOf('recovery was superseded before delivery')).toBeLessThan(prepare.indexOf('insert into public.unified_messages'))
    expect(sql).toContain('grant execute on function public.sales_claim_stale_hold_recovery')
    expect(sql).not.toContain('grant execute on function public.sales_claim_stale_hold_recovery(uuid, uuid, uuid, bigint) to authenticated')
  })

  it('rejects cross-workspace requests, wrong holds, later customer turns, and human replies before claiming', async () => {
    const sql = await migration()
    expect(sql).toContain('ca.user_id = p_workspace_id for update of c')
    expect(sql).toContain("role in ('owner', 'founder')")
    expect(sql).toContain("human_agent_reason <> 'quote_without_database_price'")
    expect(sql).toContain("m.sender_type = 'customer' and m.is_internal is distinct from true")
    expect(sql).toContain("m.sender_attribution in ('human_via_external', 'human_via_caye')")
    expect(sql.indexOf('where c.id = p_conversation_id and ca.user_id = p_workspace_id')).toBeLessThan(
      sql.indexOf('where original_message_id = p_original_message_id for update')
    )
  })

  it('serializes concurrent attempts and preserves the hold through uncertain delivery', async () => {
    const sql = await migration()
    expect(sql).toContain('where original_message_id = p_original_message_id for update')
    expect(sql).toContain("'already_' || v_existing.status")
    expect(sql).toContain('on conflict (original_message_id) do nothing')
    expect(sql).toContain("status = 'delivery_attempting'")
    expect(sql).toContain("status = 'delivery_unknown'")
    const complete = sql.slice(sql.indexOf('sales_complete_stale_hold_recovery'))
    expect(complete.indexOf("status = 'sent'")).toBeGreaterThan(complete.indexOf('select not exists'))
    expect(sql).toContain("and human_agent_reason = v_recovery.stale_hold_reason")
  })

  it('uses the existing lifecycle replay receipt for the stored provider message', async () => {
    // The recovery passes the original channel_message_id to the unchanged
    // Sales boundary; its lifecycle key is inbound:<id>:human_reply_received.
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('./inbound.ts', import.meta.url), 'utf8'))
    expect(source).toContain('eventKey: `inbound:${eventRoot}:${event}`')
  })
})
