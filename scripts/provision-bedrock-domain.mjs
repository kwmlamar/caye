#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js'

const SOURCE_SYSTEM = 'bedrock'
const SECRET_PREFIX = 'DOMAIN_SECRET_'
const CREDENTIAL_REF_PATTERN = /^[a-z0-9_]{1,64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REQUIRED_TABLES = [
  'business_entities',
  'business_entity_relations',
  'domain_source_connections',
  'domain_sync_cursors',
  'domain_entity_observation_state',
  'domain_change_source_snapshots',
]

const REQUIRED_RPC_PATHS = ['/rpc/ingest_external_domain_event']

function fail(message) {
  throw new Error(message)
}

export function domainSecretEnvName(credentialRef) {
  const ref = String(credentialRef ?? '').trim().toLowerCase()
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    fail('credential_ref must be 1-64 lowercase characters of [a-z0-9_]')
  }
  return `${SECRET_PREFIX}${ref.toUpperCase()}`
}

function normalizeUrl(raw, label) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    fail(`${label} must be a valid URL`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    fail(`${label} must use https outside localhost`)
  }
  return url.toString().replace(/\/$/, '')
}

export function parseArgs(argv) {
  const values = {}
  let apply = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`)
    values[key] = value
    i += 1
  }

  const workspaceId = String(values['workspace-id'] ?? '').trim()
  const bedrockCompanyId = String(values['bedrock-company-id'] ?? '').trim()
  const credentialRef = String(values['credential-ref'] ?? '').trim().toLowerCase()
  const bedrockSupabaseUrl = normalizeUrl(values['bedrock-supabase-url'], '--bedrock-supabase-url')

  if (!UUID_PATTERN.test(workspaceId)) fail('--workspace-id must be a UUID')
  if (!UUID_PATTERN.test(bedrockCompanyId)) fail('--bedrock-company-id must be a UUID')
  domainSecretEnvName(credentialRef)

  return { workspaceId, bedrockCompanyId, credentialRef, bedrockSupabaseUrl, apply }
}

function createServerClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function requireWorkspace(caye, workspaceId) {
  const { data, error } = await caye.from('customers').select('id').eq('id', workspaceId).maybeSingle()
  if (error) fail(`workspace lookup failed: ${error.message}`)
  return Boolean(data?.id)
}

async function probeTables(caye) {
  const missing = []
  for (const table of REQUIRED_TABLES) {
    const { error } = await caye.from(table).select('*', { head: true, count: 'exact' }).limit(1)
    if (error) missing.push({ name: table, error: error.message })
  }
  return missing
}

async function probeRpcSurface(cayeUrl, cayeKey) {
  let response
  try {
    response = await fetch(`${cayeUrl}/rest/v1/`, {
      headers: {
        apikey: cayeKey,
        Authorization: `Bearer ${cayeKey}`,
        Accept: 'application/openapi+json',
      },
    })
  } catch (error) {
    fail(`Caye schema discovery failed: ${error instanceof Error ? error.message : 'network error'}`)
  }
  if (!response.ok) fail(`Caye schema discovery failed with HTTP ${response.status}`)
  const spec = await response.json()
  const paths = spec?.paths ?? {}
  return REQUIRED_RPC_PATHS.filter((path) => !(path in paths))
}

async function getExistingConnection(caye, workspaceId) {
  const { data, error } = await caye
    .from('domain_source_connections')
    .select('id,workspace_id,source_system,external_tenant_id,status,credential_ref,config')
    .eq('workspace_id', workspaceId)
    .eq('source_system', SOURCE_SYSTEM)
    .maybeSingle()
  if (error) fail(`connection lookup failed: ${error.message}`)
  return data ?? null
}

export function connectionMatches(existing, desired) {
  if (!existing) return false
  const existingUrl = typeof existing.config?.supabase_url === 'string'
    ? existing.config.supabase_url.replace(/\/$/, '')
    : null
  return existing.source_system === SOURCE_SYSTEM
    && existing.external_tenant_id === desired.bedrockCompanyId
    && existing.status === 'active'
    && existing.credential_ref === desired.credentialRef
    && existingUrl === desired.bedrockSupabaseUrl
}

async function verifyBedrockCompany(url, secret, companyId) {
  const bedrock = createServerClient(url, secret)
  const { data, error } = await bedrock.from('companies').select('id').eq('id', companyId).maybeSingle()
  if (error) fail(`Bedrock read-only company check failed: ${error.message}`)
  return Boolean(data?.id)
}

async function insertConnection(caye, desired) {
  const { error } = await caye.from('domain_source_connections').insert({
    workspace_id: desired.workspaceId,
    source_system: SOURCE_SYSTEM,
    external_tenant_id: desired.bedrockCompanyId,
    status: 'active',
    credential_ref: desired.credentialRef,
    config: { supabase_url: desired.bedrockSupabaseUrl },
  })
  if (error) fail(`connection insert failed: ${error.message}`)
}

export async function runProvisioning(args, env = process.env) {
  const cayeUrl = normalizeUrl(env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL')
  const cayeKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!cayeKey) fail('SUPABASE_SERVICE_ROLE_KEY is not set')

  const secretName = domainSecretEnvName(args.credentialRef)
  const bedrockSecret = String(env[secretName] ?? '')
  const secretResolvable = bedrockSecret.trim().length > 0

  const caye = createServerClient(cayeUrl, cayeKey)
  const workspaceFound = await requireWorkspace(caye, args.workspaceId)
  const missingTables = await probeTables(caye)
  const missingRpcPaths = await probeRpcSurface(cayeUrl, cayeKey)
  const schemaPresent = missingTables.length === 0 && missingRpcPaths.length === 0

  const existing = schemaPresent ? await getExistingConnection(caye, args.workspaceId) : null
  const exactExistingConnection = connectionMatches(existing, args)

  let bedrockCompanyReachable = false
  if (secretResolvable) {
    bedrockCompanyReachable = await verifyBedrockCompany(
      args.bedrockSupabaseUrl,
      bedrockSecret,
      args.bedrockCompanyId,
    )
  }

  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    workspace_found: workspaceFound,
    bedrock_company_binding: args.bedrockCompanyId,
    connection_status: existing?.status ?? 'missing',
    connection_exact_match: exactExistingConnection,
    credential_reference_present: Boolean(args.credentialRef),
    secret_resolvable: secretResolvable,
    bedrock_company_reachable_read_only: bedrockCompanyReachable,
    required_schema_present: schemaPresent,
    missing_schema_tables: missingTables.map((item) => item.name),
    missing_rpc_paths: missingRpcPaths,
    writes_performed: false,
    sync_invoked: false,
  }

  const blockers = []
  if (!workspaceFound) blockers.push('workspace not found')
  if (!schemaPresent) blockers.push('required Caye domain schema is incomplete')
  if (!secretResolvable) blockers.push('credential reference does not resolve to a server secret')
  if (!bedrockCompanyReachable) blockers.push('Bedrock company binding could not be verified read-only')
  if (existing && !exactExistingConnection) {
    blockers.push('an existing Bedrock connection differs from the requested binding; refusing to repoint it')
  }

  if (args.apply && blockers.length === 0 && !existing) {
    await insertConnection(caye, args)
    report.connection_status = 'active'
    report.connection_exact_match = true
    report.writes_performed = true
  }

  return { report, blockers }
}

function printReport(report, blockers) {
  console.log(JSON.stringify({ ...report, blockers }, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { report, blockers } = await runProvisioning(args)
  printReport(report, blockers)
  if (blockers.length > 0) process.exitCode = 1
}

const invokedDirectly = process.argv[1]
  && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'provisioning failed')
    process.exitCode = 1
  })
}
