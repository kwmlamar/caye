'use client'

import { useState, useEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'

// Same dark-console tokens as ChannelsCard/ContactsPanel — kept local per
// the established per-file pattern in this directory.
const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'
const TEAL = '#7DC9CB'

interface VoiceProfileState {
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
  signature_block: string | null
  tagline: string | null
  standard_signoff: string | null
  standard_opener: string | null
}

const EMPTY_VOICE: VoiceProfileState = {
  writing_style: '',
  common_phrases: [],
  greeting_style: '',
  signoff_style: '',
  formality_level: 'warm-professional',
  tone_notes: '',
  signature_block: null,
  tagline: null,
  standard_signoff: null,
  standard_opener: null,
}

interface WorkspaceConfig {
  system_prompt: string
  digest_days: number[]
  autosend_enabled: boolean
  workspace_kind: string | null
  ai_voice_profile: VoiceProfileState | null
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function DayChip({ label, active, onClick, disabled }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24, height: 24, borderRadius: '50%', border: 'none', flexShrink: 0,
        fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)',
        cursor: disabled ? 'default' : 'pointer',
        color: active ? '#0a0a0b' : hover && !disabled ? '#d4d4d8' : LABEL_COLOR,
        background: active ? TEAL : hover && !disabled ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
        transition: 'background 0.12s ease, color 0.12s ease',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 5 }}>
      {children}
    </div>
  )
}

const textAreaStyle: React.CSSProperties = {
  width: '100%', resize: 'vertical', background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '9px 11px',
  fontSize: 12.5, lineHeight: 1.55, color: '#f4f4f5', outline: 'none', fontFamily: 'inherit',
}
const textInputStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '7px 11px',
  fontSize: 12.5, color: '#f4f4f5', outline: 'none', fontFamily: 'inherit',
}

function SaveButton({ dirty, saving, onClick }: { dirty: boolean; saving: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!dirty || saving}
      style={{
        border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 11, fontWeight: 600,
        fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
        cursor: !dirty || saving ? 'default' : 'pointer',
        background: dirty && !saving ? TEAL : 'rgba(255,255,255,0.06)',
        color: dirty && !saving ? '#0a0a0b' : 'rgba(245,245,244,0.3)',
        transition: 'background 0.15s ease',
      }}
    >
      {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
    </button>
  )
}

function PhraseTags({ phrases, onChange }: { phrases: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    onChange([...phrases, v])
    setDraft('')
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {phrases.map((p, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
            background: 'rgba(125,201,203,0.1)', color: '#7DC9CB', borderRadius: 999,
            padding: '3px 6px 3px 10px',
          }}>
            {p}
            <button
              type="button"
              onClick={() => onChange(phrases.filter((_, idx) => idx !== i))}
              style={{ border: 'none', background: 'transparent', color: '#7DC9CB', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 3px' }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Add a phrase and press Enter…"
          style={{ ...textInputStyle, flex: 1 }}
        />
      </div>
    </div>
  )
}

export default function SettingsCard({ workspaceId, compact }: { workspaceId: string; compact: boolean }) {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Local editable drafts, separate from `config` (the last-saved server
  // state) so dirty-tracking and Save buttons are simple truthy checks.
  const [systemPrompt, setSystemPrompt] = useState('')
  const [voice, setVoice] = useState<VoiceProfileState>(EMPTY_VOICE)
  const [promptSaving, setPromptSaving] = useState(false)
  const [voiceSaving, setVoiceSaving] = useState(false)
  const [daySaving, setDaySaving] = useState(false)
  const [autosendSaving, setAutosendSaving] = useState(false)

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { session } = await getSession()
      if (!session) { setError('Not signed in'); return }
      const res = await fetch(`/api/founder/workspace-config?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setConfig(json)
      setSystemPrompt(json.system_prompt ?? '')
      setVoice(json.ai_voice_profile ?? EMPTY_VOICE)
    } catch {
      setError('Failed to load')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  async function patch(body: Record<string, unknown>) {
    const { session } = await getSession()
    if (!session) throw new Error('Not signed in')
    const res = await fetch(`/api/founder/workspace-config?workspaceId=${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Save failed')
  }

  async function toggleDay(day: number) {
    if (!config || daySaving) return
    const has = config.digest_days.includes(day)
    const next = has ? config.digest_days.filter((d) => d !== day) : [...config.digest_days, day].sort()
    setDaySaving(true)
    setConfig({ ...config, digest_days: next }) // optimistic
    try {
      await patch({ digest_days: next })
    } catch (err) {
      setConfig((prev) => prev ? { ...prev, digest_days: config.digest_days } : prev) // revert
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setDaySaving(false)
    }
  }

  async function toggleAutosend() {
    if (!config || autosendSaving || config.workspace_kind === 'internal_sales') return
    const next = !config.autosend_enabled
    setAutosendSaving(true)
    setConfig({ ...config, autosend_enabled: next })
    try {
      await patch({ autosend_enabled: next })
    } catch (err) {
      setConfig((prev) => prev ? { ...prev, autosend_enabled: !next } : prev)
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setAutosendSaving(false)
    }
  }

  async function savePrompt() {
    setPromptSaving(true)
    setError(null)
    try {
      await patch({ system_prompt: systemPrompt })
      setConfig((prev) => prev ? { ...prev, system_prompt: systemPrompt } : prev)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setPromptSaving(false)
    }
  }

  async function saveVoice() {
    setVoiceSaving(true)
    setError(null)
    try {
      await patch({ ai_voice_profile: voice })
      setConfig((prev) => prev ? { ...prev, ai_voice_profile: voice } : prev)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setVoiceSaving(false)
    }
  }

  const promptDirty = config !== null && systemPrompt !== (config.system_prompt ?? '')
  const voiceDirty = config !== null && JSON.stringify(voice) !== JSON.stringify(config.ai_voice_profile ?? EMPTY_VOICE)
  const isLockedAutosend = config?.workspace_kind === 'internal_sales'

  return (
    <div style={{
      background: CARD_BG, borderRadius: 16, padding: '16px 18px',
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      overflowY: compact ? 'visible' : 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR }}>
          Settings
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: LABEL_COLOR, margin: '0 0 12px', lineHeight: 1.5, flexShrink: 0 }}>
        How Caye operates for this workspace.
      </p>

      {loading ? (
        <div style={{ padding: '10px 4px' }}><CayeLoadingPulse size={14} /></div>
      ) : error && !config ? (
        <p style={{ fontSize: 12, color: '#fb7185' }}>{error}</p>
      ) : !config ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
          {error && <p style={{ fontSize: 11.5, color: '#fb7185', margin: 0 }}>{error}</p>}

          {/* Digest days — always live-editable, compact or expanded. */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <FieldLabel>Morning digest days</FieldLabel>
              {daySaving && <span style={{ fontSize: 10, color: LABEL_COLOR }}>saving…</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {DAY_LABELS.map((label, day) => (
                <DayChip key={day} label={label} active={config.digest_days.includes(day)} onClick={() => toggleDay(day)} />
              ))}
            </div>
          </div>

          {/* Autosend — always visible, locked for internal_sales. */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <FieldLabel>Autosend</FieldLabel>
              <Pill
                color={isLockedAutosend ? LABEL_COLOR : config.autosend_enabled ? '#34d399' : '#fca5a5'}
                label={isLockedAutosend ? 'Always holds' : config.autosend_enabled ? 'On' : 'Off — holds for review'}
              />
            </div>
            {isLockedAutosend ? (
              <p style={{ fontSize: 11, color: LABEL_COLOR, margin: '4px 0 0', lineHeight: 1.4 }}>
                Permanently locked off for the cold-outreach workspace — first-touch/follow-up sends always go through manual review.
              </p>
            ) : (
              <button
                type="button"
                onClick={toggleAutosend}
                disabled={autosendSaving}
                style={{
                  marginTop: 6, border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 10.5, fontWeight: 600,
                  fontFamily: 'var(--font-mono)', letterSpacing: '0.02em', cursor: autosendSaving ? 'default' : 'pointer',
                  background: 'rgba(255,255,255,0.06)', color: '#d4d4d8',
                }}
              >
                {autosendSaving ? 'Saving…' : config.autosend_enabled ? 'Turn off' : 'Turn on'}
              </button>
            )}
          </div>

          {compact ? (
            <div>
              <FieldLabel>Voice</FieldLabel>
              <p style={{ fontSize: 12, color: '#d4d4d8', margin: 0, lineHeight: 1.5 }}>
                {voice.formality_level} — {voice.tone_notes ? voice.tone_notes.slice(0, 90) + (voice.tone_notes.length > 90 ? '…' : '') : 'not set'}
              </p>
            </div>
          ) : (
            <>
              {/* System prompt */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <FieldLabel>System prompt</FieldLabel>
                  <SaveButton dirty={promptDirty} saving={promptSaving} onClick={savePrompt} />
                </div>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={8}
                  style={{ ...textAreaStyle, minHeight: 140 }}
                />
              </div>

              {/* Voice profile */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <FieldLabel>Voice profile</FieldLabel>
                  <SaveButton dirty={voiceDirty} saving={voiceSaving} onClick={saveVoice} />
                </div>

                <div>
                  <FieldLabel>Formality</FieldLabel>
                  <select
                    value={voice.formality_level}
                    onChange={(e) => setVoice({ ...voice, formality_level: e.target.value as VoiceProfileState['formality_level'] })}
                    style={{ ...textInputStyle, cursor: 'pointer' }}
                  >
                    <option value="casual">Casual</option>
                    <option value="warm-professional">Warm-professional</option>
                    <option value="formal">Formal</option>
                  </select>
                </div>

                <div>
                  <FieldLabel>Writing style</FieldLabel>
                  <textarea
                    value={voice.writing_style}
                    onChange={(e) => setVoice({ ...voice, writing_style: e.target.value })}
                    rows={3}
                    style={textAreaStyle}
                  />
                </div>

                <div>
                  <FieldLabel>Tone notes</FieldLabel>
                  <textarea
                    value={voice.tone_notes}
                    onChange={(e) => setVoice({ ...voice, tone_notes: e.target.value })}
                    rows={3}
                    style={textAreaStyle}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <FieldLabel>Greeting style</FieldLabel>
                    <input value={voice.greeting_style} onChange={(e) => setVoice({ ...voice, greeting_style: e.target.value })} style={textInputStyle} />
                  </div>
                  <div>
                    <FieldLabel>Signoff style</FieldLabel>
                    <input value={voice.signoff_style} onChange={(e) => setVoice({ ...voice, signoff_style: e.target.value })} style={textInputStyle} />
                  </div>
                </div>

                <div>
                  <FieldLabel>Common phrases</FieldLabel>
                  <PhraseTags phrases={voice.common_phrases} onChange={(next) => setVoice({ ...voice, common_phrases: next })} />
                </div>

                <details>
                  <summary style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR, cursor: 'pointer', marginBottom: 8 }}>
                    Verbatim overrides (optional)
                  </summary>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <FieldLabel>Standard opener</FieldLabel>
                      <input
                        value={voice.standard_opener ?? ''}
                        onChange={(e) => setVoice({ ...voice, standard_opener: e.target.value || null })}
                        placeholder="Leave blank to vary per message"
                        style={textInputStyle}
                      />
                    </div>
                    <div>
                      <FieldLabel>Standard signoff</FieldLabel>
                      <input
                        value={voice.standard_signoff ?? ''}
                        onChange={(e) => setVoice({ ...voice, standard_signoff: e.target.value || null })}
                        style={textInputStyle}
                      />
                    </div>
                    <div>
                      <FieldLabel>Tagline</FieldLabel>
                      <input
                        value={voice.tagline ?? ''}
                        onChange={(e) => setVoice({ ...voice, tagline: e.target.value || null })}
                        style={textInputStyle}
                      />
                    </div>
                    <div>
                      <FieldLabel>Signature block</FieldLabel>
                      <input
                        value={voice.signature_block ?? ''}
                        onChange={(e) => setVoice({ ...voice, signature_block: e.target.value || null })}
                        style={textInputStyle}
                      />
                    </div>
                  </div>
                </details>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
