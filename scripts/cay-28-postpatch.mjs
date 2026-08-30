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

console.log('CAY-28 post-patch normalization complete')
