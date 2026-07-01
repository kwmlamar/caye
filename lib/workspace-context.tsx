"use client"

import { createContext, useContext } from "react"
import type { Customer } from "@/types/database"

export interface WorkspaceMembership {
  workspace_id: string
  role: 'owner' | 'admin'
  customer: Customer
}

export interface WorkspaceContextValue {
  workspace: Customer
  workspaceId: string
  workspaces: WorkspaceMembership[]
  isOwner: boolean
  /** True when the logged-in user is on the FOUNDER_USER_IDS list
   *  (lib/founder.ts). Founders see the full power-user dashboard;
   *  non-founders see operator surface only (Home / Billing / Settings).
   *  Per CLAUDE.md dashboard scope lock. */
  isFounder: boolean
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({
  children,
  value
}: {
  children: React.ReactNode
  value: WorkspaceContextValue
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider")
  }
  return context
}
