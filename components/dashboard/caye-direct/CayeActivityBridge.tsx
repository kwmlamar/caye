 'use client'

import { useEffect } from 'react'
import { getSession } from '@/lib/supabase'

function humanToolLabel(toolName: string | null): string {
  if (!toolName) return 'Using a tool'
  if (/job|application|resume|candidate|ats/i.test(toolName)) return 'Working on job search'
  if (/research|intelligence|evidence|claim|belief/i.test(toolName)) return 'Researching'
  if (/image|vision|photo/i.test(toolName)) return 'Analyzing image'
  if (/email|gmail|inbox|draft/i.test(toolName)) return 'Checking email'
  const words = toolName.replace(/^get_|^list_|^read_|^inspect_/, '').replace(/_/g, ' ')
  return `Using ${words}`
}

function labelFor(activity: { kind?: string; label?: string | null; tool_name?: string | null } | null): string {
  if (!activity) return 'Thinking'
  if (activity.label) return activity.label
  if (activity.kind === 'analyzing_image') return 'Analyzing image'
  if (activity.kind === 'calling_tool') return humanToolLabel(activity.tool_name ?? null)
  return 'Thinking'
}

/**
 * Keeps the existing inline CayeWorkingIndicator honest without duplicating
 * the chat UI. The server records real turn/tool state; this bridge only
 * mirrors that state into the label already rendered beside Caye's mark.
 */
export default function CayeActivityBridge({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      try {
        const label = document.querySelector<HTMLElement>('.caye-working-label')
        if (!label) {
timer = setTimeout(poll, 500)
return
        }
        const { session } = await getSession()
        if (!session || cancelled) return
        let threadId: string | null = null
        try { threadId = window.localStorage.getItem(`caye-command-selected-thread:${workspaceId}`) } catch {}
        const qs = new URLSearchParams({ workspaceId })
        if (threadId) qs.set('threadId', threadId)
        const res = await fetch(`/api/founder/caye-direct/activity?${qs.toString()}`, {
headers: { Authorization: `Bearer ${session.access_token}` },
cache: 'no-store',
        })
        if (!cancelled && res.ok) {
const json = await res.json()
const next = labelFor(json.activity ?? null)
label.textContent = next
label.setAttribute('aria-label', `Caye is ${next.toLowerCase()}`)
        }
      } catch {
        // Status is cosmetic. A polling failure must never disturb the turn.
      } finally {
        if (!cancelled) timer = setTimeout(poll, 500)
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [workspaceId])

  return null
}
