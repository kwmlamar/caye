'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import Avatar from '@/components/ui/Avatar'
import SIcon from './SIcon'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface TeamMember {
  id: string
  user_id: string | null
  name: string
  email: string
  role: string
  status: string
  is_active: boolean
  invited_at: string | null
}

const ROLE_DISPLAY: Record<string, string> = {
  owner:   'Owner',
  manager: 'Manager',
  agent:   'Tour guide',
  viewer:  'Viewer',
}

const ROLE_VALUE: Record<string, string> = {
  Owner:       'owner',
  Manager:     'manager',
  'Tour guide': 'agent',
  Viewer:      'viewer',
}

export default function TeamPanel() {
  const params = useParams()
  const urlWorkspaceId = params?.workspaceId as string | undefined
  const { workspaceId: ctxWorkspaceId, workspace } = useWorkspace()
  const workspaceId = urlWorkspaceId || ctxWorkspaceId

  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('Tour guide')
  const [inviting, setInviting] = useState(false)

  const fetchMembers = useCallback(async () => {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('team_members')
      .select('id, user_id, name, email, role, status, is_active, invited_at')
      .eq('customer_id', workspaceId)
      .eq('is_active', true)
      .order('invited_at', { ascending: true })

    if (error) { toast.error('Failed to load team'); setLoading(false); return }
    setMembers((data ?? []) as TeamMember[])
    setLoading(false)
  }, [workspaceId])

  useEffect(() => {
    async function init() {
      const supabase = getSupabase()
      const { data: { user } } = await supabase.auth.getUser()
      setCurrentUserId(user?.id ?? null)
      fetchMembers()
    }
    init()
  }, [fetchMembers])

  const handleRoleChange = async (member: TeamMember, displayRole: string) => {
    const dbRole = ROLE_VALUE[displayRole]
    if (!dbRole || dbRole === member.role) return
    const supabase = getSupabase()
    const { error } = await supabase
      .from('team_members')
      .update({ role: dbRole })
      .eq('id', member.id)
    if (error) { toast.error('Failed to update role'); return }
    setMembers(ms => ms.map(m => m.id === member.id ? { ...m, role: dbRole } : m))
    toast.success(`${member.name} is now ${displayRole}`)
  }

  const handleRemove = async (member: TeamMember) => {
    const supabase = getSupabase()
    const { error } = await supabase
      .from('team_members')
      .update({ is_active: false })
      .eq('id', member.id)
    if (error) { toast.error('Failed to remove member'); return }
    setMembers(ms => ms.filter(m => m.id !== member.id))
    toast.success(`${member.name} removed`)
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    const dbRole = ROLE_VALUE[inviteRole] || 'agent'
    const supabase = getSupabase()
    const { error } = await supabase
      .from('team_members')
      .insert({
        customer_id: workspaceId,
        name: inviteEmail.split('@')[0],
        email: inviteEmail.trim(),
        role: dbRole,
        status: 'pending',
        is_active: true,
      })
    if (error) { toast.error('Failed to send invite'); setInviting(false); return }
    toast.success(`Invite sent to ${inviteEmail}`)
    setInviteEmail('')
    fetchMembers()
    setInviting(false)
  }

  const isYou = (m: TeamMember) =>
    (m.user_id && m.user_id === currentUserId) || false

  const active  = members.filter(m => m.status === 'active').length
  const pending = members.filter(m => m.status === 'pending').length

  const plan = workspace?.plan || 'free'
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1)
  const maxMembers = plan === 'pro' || plan === 'enterprise' ? 25 : plan === 'starter' || plan === 'medium' ? 8 : 3

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Team</div>
          <h1>Who&apos;s on the dock</h1>
          <p className="set-page-desc">
            Add the people who help you run tours. Owners and Managers see every
            conversation; Tour guides only see chats for the trips they&apos;re assigned to.
          </p>
        </div>
        <div className="ph-right">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tc-ink-mute)', letterSpacing: '.04em' }}>
            {loading ? '—' : `${active} active · ${pending} pending`}
          </span>
        </div>
      </header>

      <section className="s-card">
        <div className="team-table">
          <div className="team-row head">
            <span>Member</span>
            <span>Role</span>
            <span>Status</span>
            <span></span>
          </div>

          {loading ? (
            <div style={{ padding: '20px 16px', color: 'var(--tc-ink-faint)', fontSize: 13 }}>Loading…</div>
          ) : members.length === 0 ? (
            <div style={{ padding: '20px 16px', color: 'var(--tc-ink-faint)', fontSize: 13 }}>No team members yet.</div>
          ) : members.map((m) => {
            const you = isYou(m)
            const displayRole = ROLE_DISPLAY[m.role] || m.role
            return (
              <div className="team-row" key={m.id}>
                <div className="team-who">
                  <Avatar name={m.name} size={34} />
                  <div>
                    <div className="nm">
                      {m.name}
                      {you && (
                        <span style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9.5,
                          color: 'var(--tc-ink-mute)',
                          letterSpacing: '.1em',
                          marginLeft: 8,
                          padding: '2px 6px',
                          background: 'var(--tc-bg-deep)',
                          borderRadius: 4,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                        }}>
                          You
                        </span>
                      )}
                    </div>
                    <div className="em">{m.email}</div>
                  </div>
                </div>

                <select
                  className="role-select"
                  value={displayRole}
                  disabled={you}
                  onChange={(e) => handleRoleChange(m, e.target.value)}
                >
                  <option>Owner</option>
                  <option>Manager</option>
                  <option>Tour guide</option>
                  <option>Viewer</option>
                </select>

                <span className={'team-status ' + m.status}>
                  <span className="pip"></span>
                  {m.status === 'active' ? 'Active' : 'Invited'}
                </span>

                <button
                  className="team-more"
                  disabled={you}
                  title={you ? undefined : 'Remove'}
                  onClick={() => !you && handleRemove(m)}
                >
                  <SIcon name="more" size={16} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="invite-row">
          <div className="s-input-affix" style={{ flex: 1 }}>
            <span className="prefix">@</span>
            <input
              placeholder="teammate@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
            />
          </div>
          <select
            className="role-select"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            style={{ width: 140 }}
          >
            <option>Owner</option>
            <option>Manager</option>
            <option>Tour guide</option>
            <option>Viewer</option>
          </select>
          <button className="btn-solid" onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
            <SIcon name="plus" size={13} />
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </div>

        <div className="s-card-foot">
          <span>
            Invites expire after 7 days · Your {planLabel} plan includes{' '}
            <b style={{ color: 'var(--tc-ink)' }}>up to {maxMembers} members</b>
          </span>
          <button className="btn-ghost sm">Role permissions</button>
        </div>
      </section>
    </div>
  )
}
