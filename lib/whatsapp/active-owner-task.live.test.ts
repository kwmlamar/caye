import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

vi.mock('server-only', () => ({}))
import { resolveActiveOwnerTask } from './active-owner-task'

const run = process.env.RUN_LANEY_RESOLVER_LIVE === '1' ? describe : describe.skip

run('live read-only Laney resolver replay', () => {
  it('resolves the expired action, never the held queue', async () => {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
    const workspaceId = '653257d9-c0f1-4271-be6d-3e2596fd893e'
    const resolution = await resolveActiveOwnerTask({
      supabase,
      workspaceId,
      operatorId: 1,
      previousCayeMessage: "Heads up — the reply to Laney.Broussard@nbcuni.com I lined up at 9:37 PM never went out, and it has now expired. If you told me to send it, it didn't reach me. Want me to set it back up?",
      now: new Date('2026-08-14T01:56:39.066Z'),
    })
    expect(resolution.status).toBe('matched')
    if (resolution.status !== 'matched') return
    expect(resolution.task.id).toBe('93e35b8a-503d-4c50-b053-b885952a7c94')
    expect(resolution.task.conversationId).toBe('ab9c7f52-a81a-4b7c-bf87-1ab6aa597cd7')
    expect(resolution.basis).toBe('previous-message')

    const { data: accounts } = await supabase.from('connected_accounts').select('id').eq('user_id', workspaceId)
    const { data: held } = await supabase
      .from('unified_conversations')
      .select('customer_name')
      .in('connected_account_id', (accounts ?? []).map((a) => a.id))
      .eq('human_agent_enabled', true)
    expect((held ?? []).map((row) => row.customer_name)).toEqual(expect.arrayContaining(['Vasileios Gryllis', 'ruslan@accessibletravelsolutions.com']))
    expect(resolution.task.customerName).toBe('Laney.Broussard@nbcuni.com')
  })
})
