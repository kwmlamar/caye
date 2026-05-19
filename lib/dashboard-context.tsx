"use client"

import { createContext, useContext, useState } from "react"
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
  const [screen, setScreen] = useState<Screen>('chats')
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [cayeOpen, setCayeOpen] = useState(false)
  const [activeChatId, setActiveChatId] = useState('c1')
  const [pendingContactChannelId, setPendingContactChannelId] = useState<string | null>(null)

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
