"use client"

import { createContext, useContext, useState } from "react"
import { useSearchParams, useRouter, useParams } from "next/navigation"
import type { Screen } from "@/lib/types"

interface DashboardContextValue {
  screen: Screen
  setScreen: (s: Screen) => void
  sidebarExpanded: boolean
  setSidebarExpanded: (v: boolean) => void
  cayeOpen: boolean
  setCayeOpen: React.Dispatch<React.SetStateAction<boolean>>
  activeChatId: string
  setActiveChatId: (id: string) => void
  pendingContactChannelId: string | null
  setPendingContactChannelId: (id: string | null) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const params = useParams()
  const workspaceId = params?.workspaceId as string

  const tab = searchParams.get('tab') as Screen | null
  const screen = (tab === 'contacts' || tab === 'calendar') ? tab : 'chats'

  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [cayeOpen, setCayeOpen] = useState(false)
  const [activeChatId, setActiveChatId] = useState('c1')
  const [pendingContactChannelId, setPendingContactChannelId] = useState<string | null>(null)

  const setScreen = (s: Screen) => {
    const searchVal = new URLSearchParams(searchParams.toString())
    if (s === 'chats') {
      searchVal.delete('tab')
    } else {
      searchVal.set('tab', s)
    }
    const queryString = searchVal.toString()
    router.push(`/dashboard/${workspaceId}${queryString ? `?${queryString}` : ''}`)
  }

  return (
    <DashboardContext.Provider value={{
      screen, setScreen,
      sidebarExpanded, setSidebarExpanded,
      cayeOpen, setCayeOpen,
      activeChatId, setActiveChatId,
      pendingContactChannelId, setPendingContactChannelId,
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
