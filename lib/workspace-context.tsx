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
