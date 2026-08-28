import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { RegisteredCapability } from './types'

export type GoalCapabilityItem = {
  id: string
  kind: 'vision' | 'domain' | 'objective' | 'goal' | 'initiative'
  parentId: string | null
  scope: 'operator' | 'workspace'
  workspaceId: string | null
  title: string
  description: string | null
  status: 'active' | 'future' | 'blocked' | 'paused' | 'completed' | 'abandoned'
  priority: 'low' | 'medium' | 'high' | 'critical'
  targetValue: number | null
  currentValue: number | null
  unit: string | null
  targetDate: string | null
  confidence: number | null
  completionCriteria: string | null
  updatedAt: string
}

type GoalDbRow = {
  id: string
  kind: GoalCapabilityItem['kind']
  parent_id: string | null
  scope: GoalCapabilityItem['scope']
  workspace_id: string | null
  title: string
  description: string | null
  status: GoalCapabilityItem['status']
  priority: GoalCapabilityItem['priority']
  target_value: number | null
  current_value: number | null
  unit: string | null
  target_date: string | null
  confidence: number | null
  completion_criteria: string | null
  updated_at: string
}

const GOAL_COLUMNS = [
  'id',
  'kind',
  'parent_id',
  'scope',
  'workspace_id',
  'title',
  'description',
  'status',
  'priority',
  'target_value',
  'current_value',
  'unit',
  'target_date',
  'confidence',
  'completion_criteria',
  'updated_at',
].join(', ')

function toSemanticGoal(row: GoalDbRow): GoalCapabilityItem {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    scope: row.scope,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    targetValue: row.target_value,
    currentValue: row.current_value,
    unit: row.unit,
    targetDate: row.target_date,
    confidence: row.confidence,
    completionCriteria: row.completion_criteria,
    updatedAt: row.updated_at,
  }
}

/**
 * Founder read boundary for durable direction.
 *
 * Scope comes only from the trusted invocation context. A caller cannot place a
 * workspace id in args and thereby widen what it can see. `workspaceId=null`
 * means operator scope; a concrete workspace id means exactly that workspace.
 */
export const goalsListCapability: RegisteredCapability<Record<string, never>, GoalCapabilityItem[]> = {
  manifest: {
    name: 'goals.list',
    version: 1,
    namespace: 'goals',
    description: 'List durable goals and direction in the trusted founder scope.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'goals.list.input.v1',
    outputSchemaId: 'goals.list.output.v1',
  },

  async execute(_args, context) {
    try {
      const supabase = createServiceClient()
      let query = supabase
        .from('caye_goals')
        .select(GOAL_COLUMNS)
        .is('superseded_at', null)
        .order('created_at', { ascending: true })

      if (context.scope.workspaceId) {
        query = query
          .eq('scope', 'workspace')
          .eq('workspace_id', context.scope.workspaceId)
      } else {
        query = query
          .eq('scope', 'operator')
          .is('workspace_id', null)
      }

      const { data, error } = await query
      if (error) {
        return {
          status: 'failed',
          data: null,
          evidence: [],
          executionRef: null,
          auditRef: null,
          failure: {
            code: 'unavailable',
            message: 'Goal state could not be read.',
            retryable: true,
          },
        }
      }

      const rows = ((data ?? []) as unknown as GoalDbRow[]).map(toSemanticGoal)
      return {
        status: 'observed',
        data: rows,
        evidence: rows.map((goal) => ({ kind: 'record' as const, id: goal.id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return {
        status: 'failed',
        data: null,
        evidence: [],
        executionRef: null,
        auditRef: null,
        failure: {
          code: 'unavailable',
          message: 'Goal state could not be read.',
          retryable: true,
        },
      }
    }
  },
}
