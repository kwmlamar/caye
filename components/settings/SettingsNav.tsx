'use client'

import { useState, useEffect } from 'react'
import SIcon from './SIcon'
import { SET_NAV } from '@/lib/data/settings'
import type { SettingsSection } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

function NavItem({
  item,
  sub,
  active,
  onClick,
}: {
  item: typeof SET_NAV[number]
  sub: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button className={'set-nav-item' + (active ? ' active' : '')} onClick={onClick}>
      <span className="set-nav-icon"><SIcon name={item.icon} size={15} /></span>
      <span className="sn-text">
        <span className="sn-label">{item.label}</span>
        <span className="sn-sub">{sub}</span>
      </span>
      {item.badge && <span className="sn-pill">{item.badge}</span>}
    </button>
  )
}

export default function SettingsNav({
  active,
  setActive,
}: {
  active: SettingsSection
  setActive: (s: SettingsSection) => void
}) {
  const { workspace, workspaceId } = useWorkspace()
  const [teamCount, setTeamCount] = useState<number | null>(null)
  const [channelCount, setChannelCount] = useState<number | null>(null)

  useEffect(() => {
    async function loadCounts() {
      const supabase = getSupabase()
      const [{ count: members }, { count: channels }] = await Promise.all([
        // team_members has no RLS — readable by any authenticated user
        supabase
          .from('team_members')
          .select('*', { count: 'exact', head: true })
          .eq('customer_id', workspaceId)
          .eq('is_active', true),
        supabase
          .from('connected_accounts')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', workspaceId)
          .eq('is_active', true),
      ])
      setTeamCount(members ?? null)
      setChannelCount(channels ?? null)
    }
    loadCounts()
  }, [workspaceId])

  const bizName = (workspace?.business_name || 'my workspace').toLowerCase()
  const tz = workspace?.timezone
    ? workspace.timezone.split('/')[1]?.replace(/_/g, ' ').toLowerCase() || workspace.timezone
    : ''

  const plan = workspace?.plan || 'free'
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1)
  const trialDays = workspace?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86400000))
    : 0

  function getSub(id: string, staticSub: string): string {
    switch (id) {
      case 'billing':
        return trialDays > 0 ? `${planLabel} · trial ${trialDays}d` : planLabel
      case 'team':
        return teamCount !== null ? `${teamCount} member${teamCount !== 1 ? 's' : ''}` : staticSub
      case 'channels':
        return channelCount !== null ? `${channelCount} connection${channelCount !== 1 ? 's' : ''}` : staticSub
      default:
        return staticSub
    }
  }

  return (
    <aside className="set-nav">
      <div className="set-nav-head">
        <div className="set-nav-eyebrow">Workspace</div>
        <div className="set-nav-title">Settings</div>
        <div className="set-nav-org">{bizName}{tz ? ` · ${tz}` : ''}</div>
      </div>
      <nav className="set-nav-list">
        <div className="set-nav-section-label">General</div>
        {SET_NAV.slice(0, 2).map((it) => (
          <NavItem
            key={it.id}
            item={it}
            sub={getSub(it.id, it.sub)}
            active={active === it.id}
            onClick={() => setActive(it.id as SettingsSection)}
          />
        ))}

        <div className="set-nav-section-label">Automation</div>
        {SET_NAV.slice(2, 4).map((it) => (
          <NavItem
            key={it.id}
            item={it}
            sub={getSub(it.id, it.sub)}
            active={active === it.id}
            onClick={() => setActive(it.id as SettingsSection)}
          />
        ))}

        <div className="set-nav-section-label">Workspace</div>
        {SET_NAV.slice(4).map((it) => (
          <NavItem
            key={it.id}
            item={it}
            sub={getSub(it.id, it.sub)}
            active={active === it.id}
            onClick={() => setActive(it.id as SettingsSection)}
          />
        ))}
      </nav>
    </aside>
  )
}
