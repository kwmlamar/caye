'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'
import {
  getStandingRules,
  addStandingRule,
  deleteStandingRule,
  channelName,
  channelCode,
  type StandingRule,
} from '@/lib/data/mobile'
import MIcon from '../MIcon'
import MobileChannelsSheet from '../MobileChannelsSheet'

const EXAMPLES = [
  "Don't accept bookings less than 2 hours before tour start time.",
  'If a guest mentions seasickness, recommend the calmer morning trip.',
]

export default function RulesScreen() {
  const { workspace } = useWorkspace()
  const [rules, setRules] = useState<StandingRule[] | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [channels, setChannels] = useState<string[]>([])
  const [showChannels, setShowChannels] = useState(false)

  const loadRules = useCallback(() => {
    getStandingRules(workspace.id).then(setRules)
  }, [workspace.id])

  const loadChannels = useCallback(() => {
    const supabase = getSupabase()
    supabase
      .from('connected_accounts')
      .select('channel_type')
      .eq('user_id', workspace.id)
      .eq('is_active', true)
      .then(({ data }) => {
        const types = [...new Set((data ?? []).map((a: { channel_type: string }) => a.channel_type))]
        setChannels(types)
      })
  }, [workspace.id])

  useEffect(() => {
    loadRules()
    loadChannels()
  }, [loadRules, loadChannels])

  const save = async () => {
    if (!draft.trim()) return
    setSaving(true)
    const { error } = await addStandingRule(workspace.id, draft)
    setSaving(false)
    if (!error) {
      setDraft('')
      loadRules()
    }
  }

  const remove = async (id: string) => {
    setRules(prev => prev?.filter(r => r.id !== id) ?? null)
    await deleteStandingRule(id)
  }

  const totalUses = (rules ?? []).reduce((s, r) => s + r.times_used, 0)
  const channelLabel =
    channels.length > 0
      ? channels.map(c => channelName(channelCode(c))).join(', ')
      : 'No channels connected yet'

  return (
    <>
    <div className="m-screen" data-screen-label="Standing rules">
      <div className="m-screen-head">
        <div className="eyebrow">
          <MIcon name="spark" size={11} />
          Train Caye
        </div>
        <h1>Standing rules</h1>
        <div className="sub">
          Tell Caye how to handle things in plain English. She follows these on every conversation.
        </div>
      </div>

      <div className="rules-intro">
        <div className="ic">
          <MIcon name="spark" size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ttl">
            {rules === null
              ? 'Loading rules…'
              : `${rules.length} rule${rules.length === 1 ? '' : 's'} active`}
          </div>
          <div className="sub">
            {totalUses > 0 ? (
              <>
                Applied <b style={{ color: 'var(--m-ink)' }}>{totalUses} times</b> across your
                conversations.
              </>
            ) : (
              'Caye will start applying these as conversations come in.'
            )}
          </div>
        </div>
      </div>

      <div className="m-section-label">
        <span>Your rules</span>
        {rules && rules.length > 0 && <span className="right">Tap trash to remove</span>}
      </div>

      {rules === null ? (
        <div className="rules-empty">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="rules-empty">No rules yet — add your first one below.</div>
      ) : (
        <div className="rules-list">
          {rules.map((r, i) => (
            <div className="rule-row" key={r.id}>
              <span className="rule-num">{String(i + 1).padStart(2, '0')}</span>
              <div className="rule-body">
                <div className="rule-text">{r.rule_text}</div>
                <div className="rule-meta">
                  Added{' '}
                  {new Date(r.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {r.times_used > 0 ? ` · used ${r.times_used} times` : ''}
                </div>
              </div>
              <button
                className="rule-chev"
                onClick={() => remove(r.id)}
                aria-label="Remove rule"
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <MIcon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="m-section-label" style={{ marginTop: 22 }}>
        <span>Teach Caye a new rule</span>
      </div>

      <div className="rule-add">
        <div className="lbl">Write in plain English</div>
        <textarea
          placeholder="e.g. Always ask for the tour date before confirming…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div className="examples">
          {EXAMPLES.map(ex => (
            <button key={ex} className="rule-ex" onClick={() => setDraft(ex)}>
              {ex.length > 28 ? ex.slice(0, 26) + '…' : ex}
            </button>
          ))}
        </div>
        <div className="foot">
          <button
            className="btn-pri coral"
            style={{ width: '100%' }}
            disabled={saving || !draft.trim()}
            onClick={save}
          >
            <MIcon name="plus" size={14} /> {saving ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>

      <div className="m-section-label" style={{ marginTop: 22 }}>
        <span>Account</span>
      </div>
      <div className="settings-list" style={{ marginBottom: 16 }}>
        <div className="settings-row">
          <div className="ic">
            <MIcon name="people" size={16} />
          </div>
          <div className="body">
            <div className="ttl">Business profile</div>
            <div className="sub">{workspace.business_name || 'Your business'}</div>
          </div>
        </div>
        <div
          className="settings-row"
          onClick={() => setShowChannels(true)}
          style={{ cursor: 'pointer' }}
        >
          <div className="ic">
            <MIcon name="msg" size={16} />
          </div>
          <div className="body">
            <div className="ttl">Connected channels</div>
            <div className="sub">{channelLabel}</div>
          </div>
          <span className="chev">
            <MIcon name="chev" size={16} />
          </span>
        </div>
        <div className="settings-row">
          <div className="ic">
            <MIcon name="bell-fill" size={14} />
          </div>
          <div className="body">
            <div className="ttl">Notifications</div>
            <div className="sub">Install Caye to your home screen for alerts</div>
          </div>
        </div>
      </div>
    </div>

    {showChannels && (
      <MobileChannelsSheet
        workspaceId={workspace.id}
        onClose={() => {
          setShowChannels(false)
          loadChannels()
        }}
      />
    )}
    </>
  )
}
