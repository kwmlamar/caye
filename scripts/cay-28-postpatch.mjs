import fs from 'node:fs'

function replaceOne(path, from, to) {
  let source = fs.readFileSync(path, 'utf8')
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${path}: expected one match for ${from}, found ${count}`)
  source = source.replace(from, to)
  fs.writeFileSync(path, source)
}

replaceOne(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "      const { data: existing } = await existingQuery",
  "      let { data: existing } = await existingQuery"
)
replaceOne(
  'lib/caye-agent/tools/high-risk-gate.ts',
  "        existing = ownerExisting",
  "        existing = ownerExisting.data"
)

// Keep the resolver compatible with the existing minimal Supabase gate mocks.
// Validity still fails closed, but valid_from is evaluated alongside expires_at
// after retrieval instead of requiring another query-builder method.
replaceOne(
  'lib/decision-authority.ts',
  ".eq('workspace_id', input.workspaceId)\n    .is('revoked_at', null)\n    .lte('valid_from', now)",
  ".eq('workspace_id', input.workspaceId)\n    .is('revoked_at', null)"
)
replaceOne(
  'lib/decision-authority.ts',
  "  const activeDelegations = (delegations ?? []).filter((row) => {\n    const expiresAt = row.expires_at as string | null\n    return !expiresAt || Date.parse(expiresAt) > Date.now()\n  })",
  "  const activeDelegations = (delegations ?? []).filter((row) => {\n    const validFrom = row.valid_from as string | null\n    const expiresAt = row.expires_at as string | null\n    const nowMs = Date.now()\n    return (!validFrom || Date.parse(validFrom) <= nowMs) && (!expiresAt || Date.parse(expiresAt) > nowMs)\n  })"
)

// CAY-28 makes business decision authority explicit. These historical gate
// tests are about staging/idempotency/claims, not about whether an owner is
// authorized, so their fake DB now says that plainly instead of relying on
// the old implicit "current operator == approver" assumption.
replaceOne(
  'lib/caye-agent/tools/high-risk-gate.test.ts',
  "    from(_table: string) {\n      return {",
  `    from(_table: string) {
      if (_table === 'operator_allowlist') {
        let workspaceId = 'ws-default'
        const builder = {
          select() { return builder },
          eq(col: string, val: unknown) { if (col === 'workspace_id') workspaceId = String(val); return builder },
          then(resolve: (v: { data: Row[]; error: null }) => void) {
            resolve({ data: [{ id: 1, workspace_id: workspaceId, name: 'Authorized owner', role: 'owner', verified_at: '2026-08-30T00:00:00.000Z', decision_scopes: ['business.*', 'routing.*'] }], error: null })
          },
        }
        return builder
      }
      if (_table === 'operator_authority_delegations') {
        const builder = {
          select() { return builder },
          eq() { return builder },
          is() { return builder },
          then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: [], error: null }) },
        }
        return builder
      }
      return {`
)

// Production-shaped resolver regression: verified owner + verified founder +
// unverified purported owner must still route to the verified owner.
replaceOne(
  'lib/decision-authority.test.ts',
  "        principal({ id: 13, role: 'founder', name: 'Platform founder', directScopes: [] }),",
  "        principal({ id: 13, role: 'founder', name: 'Platform founder', directScopes: [] }),\n        principal({ id: 22, role: 'owner', name: 'Unverified purported owner', verifiedAt: null, directScopes: ['business.*'] }),"
)

console.log('CAY-28 post-patch normalization complete')
