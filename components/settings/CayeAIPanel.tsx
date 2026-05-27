'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import SIcon from './SIcon'
import SaveBar from './SaveBar'
import Toggle from '@/components/ui/Toggle'
import { TONES, DELAYS } from '@/lib/data/settings'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface EscalationTopic {
  id: number
  label: string
  desc: string
}

interface AiForm {
  aiEnabled: boolean
  autoReply: boolean
  holdHours: boolean
  tone: string
  delay: string
  systemPrompt: string
  neverSay: string
  topics: EscalationTopic[]
}

const DEFAULT_FORM: AiForm = {
  aiEnabled: true,
  autoReply: true,
  holdHours: true,
  tone: 'friendly',
  delay: '60',
  systemPrompt: '',
  neverSay: '',
  topics: [],
}

function parseTopics(raw: string | null): EscalationTopic[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

interface Stats {
  conversations: number
  autoReplies: number
  escalated: number
  loading: boolean
}

export default function CayeAIPanel() {
  const { workspace, workspaceId } = useWorkspace()
  const [form, setForm] = useState<AiForm>(DEFAULT_FORM)
  const [orig, setOrig] = useState<AiForm>(DEFAULT_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const [newTopic, setNewTopic] = useState('')
  const [stats, setStats] = useState<Stats>({ conversations: 0, autoReplies: 0, escalated: 0, loading: true })

  useEffect(() => {
    async function load() {
      const supabase = getSupabase()

      const [aiRes, accountsRes] = await Promise.all([
        supabase
          .from('workspace_ai_config')
          .select('tone, system_prompt, escalation_rules, never_say, hold_hours, reply_delay, ai_enabled')
          .eq('workspace_id', workspaceId)
          .maybeSingle(),
        supabase
          .from('connected_accounts')
          .select('id')
          .eq('user_id', workspaceId),
      ])

      const initial: AiForm = {
        aiEnabled: aiRes.data?.ai_enabled ?? true,
        autoReply: workspace.auto_reply_enabled ?? true,
        holdHours: aiRes.data?.hold_hours ?? true,
        tone: aiRes.data?.tone || 'friendly',
        delay: aiRes.data?.reply_delay || '60',
        systemPrompt: aiRes.data?.system_prompt || '',
        neverSay: aiRes.data?.never_say || '',
        topics: parseTopics(aiRes.data?.escalation_rules),
      }
      setForm(initial)
      setOrig(initial)

      const accountIds = (accountsRes.data ?? []).map((a: { id: string }) => a.id)
      if (accountIds.length === 0) {
        setStats({ conversations: 0, autoReplies: 0, escalated: 0, loading: false })
        return
      }

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [convsRes, escalatedRes] = await Promise.all([
        supabase
          .from('unified_conversations')
          .select('id, human_agent_enabled')
          .in('connected_account_id', accountIds)
          .gte('last_message_at', since),
        supabase
          .from('unified_conversations')
          .select('id', { count: 'exact', head: true })
          .in('connected_account_id', accountIds)
          .eq('human_agent_enabled', true)
          .gte('last_message_at', since),
      ])

      const convIds = (convsRes.data ?? []).map((c: { id: string }) => c.id)
      let autoReplies = 0
      if (convIds.length > 0) {
        const { count } = await supabase
          .from('unified_messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .eq('sender_type', 'business')
          .eq('metadata->>is_automated', 'true')
          .gte('sent_at', since)
        autoReplies = count ?? 0
      }

      setStats({
        conversations: convsRes.data?.length ?? 0,
        autoReplies,
        escalated: escalatedRes.count ?? 0,
        loading: false,
      })
    }
    load()
  }, [workspaceId, workspace.auto_reply_enabled])

  const isDirty = JSON.stringify(form) !== JSON.stringify(orig)

  const setField = <K extends keyof AiForm>(k: K, v: AiForm[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const addTopic = () => {
    if (!newTopic.trim()) return
    setField('topics', [
      ...form.topics,
      { id: Date.now(), label: newTopic.trim(), desc: 'Added just now' },
    ])
    setNewTopic('')
  }

  const removeTopic = (id: number) =>
    setField('topics', form.topics.filter(t => t.id !== id))

  const handleDiscard = () => setForm(orig)

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const supabase = getSupabase()

      // Save auto_reply_enabled to customers
      if (form.autoReply !== orig.autoReply) {
        const { error } = await supabase
          .from('customers')
          .update({ auto_reply_enabled: form.autoReply })
          .eq('id', workspaceId)
        if (error) throw new Error(error.message)
      }

      // Upsert workspace_ai_config
      const { error: aiErr } = await supabase
        .from('workspace_ai_config')
        .upsert(
          {
            workspace_id: workspaceId,
            ai_enabled: form.aiEnabled,
            tone: form.tone,
            reply_delay: form.delay,
            hold_hours: form.holdHours,
            system_prompt: form.systemPrompt,
            escalation_rules: JSON.stringify(form.topics),
            never_say: form.neverSay,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id' }
        )
      if (aiErr) throw new Error(aiErr.message)

      setOrig(form)
      toast.success('Caye AI settings saved')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Caye AI</div>
          <h1>Your AI host</h1>
          <p className="set-page-desc">
            Caye is the AI that answers guests when you can&apos;t. Set her voice, what she knows, and when she should pull you in.
          </p>
        </div>
      </header>

      <div className="caye-banner">
        <div className="cb-mark">C</div>
        <div className="cb-body">
          <div className="cb-title">
            {stats.loading ? 'Loading…' : `Caye handled ${stats.conversations} conversation${stats.conversations !== 1 ? 's' : ''} this week`}
          </div>
          <div className="cb-desc">
            {stats.loading
              ? ''
              : stats.conversations === 0
              ? 'No conversations yet this week. Caye is ready to reply as soon as guests reach out.'
              : `She sent ${stats.autoReplies} auto-repl${stats.autoReplies !== 1 ? 'ies' : 'y'} and escalated ${stats.escalated} to you.`}
          </div>
          {!stats.loading && stats.conversations > 0 && (
            <div className="cb-stat">
              <div className="cb-stat-item"><b>{stats.conversations}</b>conversations</div>
              <div className="cb-stat-item"><b>{stats.autoReplies}</b>auto-replies</div>
              <div className="cb-stat-item"><b>{stats.escalated}</b>escalated</div>
            </div>
          )}
        </div>
      </div>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Status &amp; schedule</h3>
            <div className="desc">Caye answers automatically when she&apos;s on. Set quiet hours so she doesn&apos;t ping guests at 3am.</div>
          </div>
        </div>
        <div className="s-card-body" style={{ gap: 0 }}>
          <div className="s-toggle-row">
            <div className="tr-left">
              <div className="tr-title">Caye AI on</div>
              <div className="tr-desc">Master switch. When off, Caye stops generating and sending AI replies on every channel — messages still arrive in your inbox, nothing is disconnected.</div>
            </div>
            <Toggle on={form.aiEnabled} onChange={v => setField('aiEnabled', v)} />
          </div>
          <div className="s-toggle-row">
            <div className="tr-left">
              <div className="tr-title">Auto-reply enabled</div>
              <div className="tr-desc">When on, Caye replies to incoming messages across all connected channels. You can still take over any conversation from the inbox.</div>
            </div>
            <Toggle on={form.autoReply} onChange={v => setField('autoReply', v)} />
          </div>
          <div className="s-toggle-row">
            <div className="tr-left">
              <div className="tr-title">
                Hold messages during quiet hours{' '}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tc-ink-mute)', marginLeft: 6, fontWeight: 400 }}>
                  10:00pm – 6:30am
                </span>
              </div>
              <div className="tr-desc">Caye still drafts replies but waits until business hours to send. Urgent topics in your escalation list bypass this.</div>
            </div>
            <Toggle on={form.holdHours} onChange={v => setField('holdHours', v)} />
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Voice &amp; tone</h3>
            <div className="desc">How Caye sounds. You can change this anytime — she&apos;ll regenerate her response style on the next message.</div>
          </div>
        </div>
        <div className="s-card-body">
          <div className="radio-cards">
            {TONES.map((t) => (
              <button
                key={t.id}
                className={'radio-card' + (form.tone === t.id ? ' on' : '')}
                onClick={() => setField('tone', t.id)}
              >
                <span className="rc-check"></span>
                <span className="rc-icon">{t.icon}</span>
                <span className="rc-title">{t.title}</span>
                <span className="rc-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="s-row" style={{ marginTop: 8 }}>
            <div className="s-label">
              Response delay
              <span className="help">Adds a brief wait so replies don&apos;t feel robotic.</span>
            </div>
            <div className="s-field">
              <div className="s-seg">
                {DELAYS.map((d) => (
                  <button key={d.id} className={form.delay === d.id ? 'on' : ''} onClick={() => setField('delay', d.id)}>
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="s-help">
                {form.delay === '0'
                  ? 'Caye replies the instant a message arrives.'
                  : `Caye waits ${DELAYS.find(d => d.id === form.delay)?.label} before sending. Feels more like a real person typing.`}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>What Caye should know</h3>
            <div className="desc">Drop in everything specific to your operation. Pricing, schedules, what to say about weather, your refund policy, the tone of your typical messages.</div>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--tc-ink-faint)', fontWeight: 600, textTransform: 'uppercase' }}>
            {form.systemPrompt.length} / 4000
          </span>
        </div>
        <div className="s-card-body">
          <textarea
            className="s-textarea"
            style={{ minHeight: 200 }}
            value={form.systemPrompt}
            maxLength={4000}
            onChange={(e) => setField('systemPrompt', e.target.value)}
            placeholder="Tell Caye about your tours, prices, pickup locations, refund policy, anything she'd need to answer a guest…"
          />
          <div className="s-help" style={{ marginTop: 0 }}>
            <SIcon name="tick" size={12} /> Caye re-trains on this every time you save.
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Never say</h3>
            <div className="desc">Words, phrases, or commitments Caye must never use — prices you haven&apos;t set, guarantees you can&apos;t make, competitor names.</div>
          </div>
        </div>
        <div className="s-card-body">
          <textarea
            className="s-textarea"
            style={{ minHeight: 80 }}
            value={form.neverSay}
            onChange={(e) => setField('neverSay', e.target.value)}
            placeholder="e.g. 'guaranteed', 'no charge', competitor names…"
          />
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Escalate to a human</h3>
            <div className="desc">When a message matches one of these topics, Caye stops, drafts a reply for your review, and notifies you. She never sends on these.</div>
          </div>
        </div>
        <div className="topic-list" style={{ margin: '18px 22px 0', borderRadius: 10 }}>
          {form.topics.map((t) => (
            <div key={t.id} className="topic-item">
              <span className="ti-icon"><SIcon name="warn" size={14} /></span>
              <div className="ti-body">
                <div className="ti-name">{t.label}</div>
                <div className="ti-desc">{t.desc}</div>
              </div>
              <button className="btn-ghost sm danger" onClick={() => removeTopic(t.id)}>Remove</button>
            </div>
          ))}
          {form.topics.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--tc-ink-mute)' }}>
              No escalation topics yet.
            </div>
          )}
        </div>
        <div className="s-card-body" style={{ paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="Add a topic — e.g. 'lost passport', 'shark allergies'…"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTopic()}
            />
            <button className="btn-solid" onClick={addTopic}>
              <SIcon name="plus" size={13} /> Add topic
            </button>
          </div>
        </div>
      </section>

      <SaveBar isDirty={isDirty} isSaving={isSaving} onSave={handleSave} onDiscard={handleDiscard} />
    </div>
  )
}
