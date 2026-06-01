"use client"

import { createContext, useContext, useState } from "react"
import { useSearchParams, useRouter, useParams, usePathname } from "next/navigation"
import type { Screen } from "@/lib/types"

interface DashboardContextValue {
  panelScreen: Screen
  setPanelScreen: (s: Screen, extraParams?: Record<string, string>) => void
  panelOpen: boolean
  setPanelOpen: (v: boolean) => void
  sidebarExpanded: boolean
  setSidebarExpanded: (v: boolean) => void
  activeChatId: string
  setActiveChatId: (id: string) => void
  pendingContactChannelId: string | null
  setPendingContactChannelId: (id: string | null) => void
  isPanelDetail: boolean
  setIsPanelDetail: (v: boolean) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const params = useParams()
  const workspaceId = params?.workspaceId as string

  const pathname = usePathname()
  const isSettings = pathname?.includes('/settings')
  const rawTab = searchParams.get('tab') as Screen | null
  const tab = (!isSettings && rawTab && ['chats', 'bookings', 'calendar', 'contacts'].includes(rawTab))
    ? rawTab
    : null
  
  const [panelOpen, setPanelOpenState] = useState(!!tab && tab !== 'home')
  const [panelScreen, setPanelScreenState] = useState<Screen>(
    (tab && tab !== 'home') ? tab : 'chats'
  )

  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [activeChatId, setActiveChatId] = useState('c1')
  const [pendingContactChannelId, setPendingContactChannelId] = useState<string | null>(null)
  const [isPanelDetail, setIsPanelDetail] = useState(false)

  const setPanelScreen = (s: Screen, extraParams?: Record<string, string>) => {
    setIsPanelDetail(false)
    setPanelScreenState(s)
    if (s === 'home') {
      setPanelOpenState(false)
    } else {
      setPanelOpenState(true)
    }

    const searchVal = new URLSearchParams(searchParams.toString())
    searchVal.delete('contactChannelId')

    if (s === 'home') {
      searchVal.delete('tab')
    } else {
      searchVal.set('tab', s)
    }

    if (extraParams) {
      Object.entries(extraParams).forEach(([k, v]) => {
        searchVal.set(k, v)
      })
    }

    const queryString = searchVal.toString()
    router.push(`/dashboard/${workspaceId}${queryString ? `?${queryString}` : ''}`)
  }

  const setPanelOpen = (open: boolean) => {
    if (!open) {
      setIsPanelDetail(false)
    }
    setPanelOpenState(open)
    const searchVal = new URLSearchParams(searchParams.toString())
    if (!open) {
      searchVal.delete('tab')
      searchVal.delete('contactChannelId')
    } else {
      searchVal.set('tab', panelScreen)
    }
    const queryString = searchVal.toString()
    router.push(`/dashboard/${workspaceId}${queryString ? `?${queryString}` : ''}`)
  }

  return (
    <DashboardContext.Provider value={{
      panelScreen, setPanelScreen,
      panelOpen, setPanelOpen,
      sidebarExpanded, setSidebarExpanded,
      activeChatId, setActiveChatId,
      pendingContactChannelId, setPendingContactChannelId,
      isPanelDetail, setIsPanelDetail,
    }}>
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error("useDashboard must be used within a DashboardProvider")
  return ctx
}
