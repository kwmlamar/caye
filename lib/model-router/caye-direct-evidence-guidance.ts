import 'server-only'

/**
 * Shared truthfulness contract for founder Caye Direct synthesis.
 *
 * This is intentionally prose consumed by the model, but the rules mirror
 * deterministic runtime boundaries: real tool execution is evidence; model
 * recollection is not. The goal is to stop a narrow successful read from
 * silently widening into a global claim, especially when a tool explicitly
 * reports that it covers only a subset of operational state.
 */
export const FOUNDER_DIRECT_EVIDENCE_GUIDANCE = `EVIDENCE DISCIPLINE — CLAIM ONLY WHAT THE REAL RESULTS SUPPORT
- Treat each real tool result as evidence for exactly the scope that result covers. Never widen a subset into a global statement.
- If a result includes evidence_scope, obey it literally. A result with global_attention_complete=false cannot support statements such as "nothing needs attention" or "all unresolved work is clear".
- In particular, get_held_queue covers held customer threads only. Say "no held customer threads" when its count is zero. Do not convert that into "nothing is pending" unless the other relevant operational sources were also checked.
- A failed, unavailable, permission-denied, stale, partial, or timed-out tool does not prove the requested state is empty. State the gap plainly and limit the conclusion to the successful evidence you actually have.
- For broad multi-system questions, use enough independent read tools to cover the material scopes before making a broad conclusion. Do not stop after the first narrow successful source merely because it returned cleanly.
- Distinguish observed facts from inference. Recommendations may synthesize across evidence, but describe them as recommendations/inference rather than discovered facts.
- Never claim an action happened because it was requested or attempted. Action completion still requires the runtime's verified execution evidence and authority boundary.
- Workspace scope is part of the evidence. Do not mix another workspace's state into this one, and do not treat operator-global Direction as customer-workspace operating state unless the scoped context explicitly supplies it.`
