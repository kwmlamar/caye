/** Acquisition automation is real only in Caye's own production Sales workspace.
 * A disposable demo workspace can exercise inbox behavior but is never a
 * source of outreach state, sends, or reporting facts. */
export function isProductionSalesWorkspace(workspace: {
  workspace_kind: string | null
  plan?: string | null
}): boolean {
  return workspace.workspace_kind === 'internal_sales' && workspace.plan !== 'demo'
}
