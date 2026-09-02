#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
const { BedrockAdapter } = await import('../lib/domain-adapters/bedrock/adapter.ts')

// MANUAL READ-ONLY SMOKE TEST ONLY.
// Do not add mutation calls, polling, domain synchronization, schema operations,
// or credential output to this runner. Production activation belongs elsewhere.
const args = process.argv.slice(2)
const flag = n => args.includes(n)
const value = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const workspaceId = value('--workspace')
const json = flag('--json')
const dryRun = flag('--dry-run')
if (!workspaceId) throw new Error('missing --workspace <id>')

const companyId = process.env.BEDROCK_COMPANY_ID
const supabaseUrl = process.env.BEDROCK_SUPABASE_URL
const credentialRef = process.env.BEDROCK_CREDENTIAL_REF
if (!companyId || !supabaseUrl || !credentialRef) throw new Error('BEDROCK_COMPANY_ID, BEDROCK_SUPABASE_URL, and BEDROCK_CREDENTIAL_REF are required')
if (!/^[a-z0-9_]{1,64}$/i.test(credentialRef)) throw new Error('invalid BEDROCK_CREDENTIAL_REF')
const secretName = `DOMAIN_SECRET_${credentialRef.toUpperCase()}`
const serviceRoleKey = process.env[secretName]
if (!serviceRoleKey) throw new Error(`${secretName} is not set`)

const connection = { workspaceId, companyId, supabaseUrl, serviceRoleKey }
const resolver = { resolve: async id => id === workspaceId ? connection : null }
const adapter = new BedrockAdapter(resolver)
const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
const evidence = []
const out = { workspaceId, companyId, dryRun, counts: {}, adapterReads: {}, poCursor: {}, sensitiveFieldAudit: { valuesRead: false }, queryEvidence: evidence, failures: [] }
const q = async (label, fn) => { evidence.push(label); if (dryRun) return null; const r = await fn(); if (r.error) throw new Error(`${label}: ${r.error.message}`); return r }
const assertMeta = (x, type) => {
  if (!x || x.sourceSystem !== 'bedrock' || x.authority !== 'external_authoritative' || x.sourceEntityType !== type || !x.sourceEntityId || x.workspaceId !== workspaceId || x.companyId !== companyId) throw new Error(`metadata mismatch for ${type}`)
}

if (!dryRun) {
  const health = await adapter.health(workspaceId); assertMeta(health, 'health'); out.adapterReads.health = health.ok
  const projects = await adapter.listProjects(workspaceId, { limit: 200 }); projects.forEach(x => assertMeta(x, 'project')); out.adapterReads.projects = projects.length
  const clients = await adapter.listClients(workspaceId, { limit: 200 }); clients.forEach(x => assertMeta(x, 'client')); out.adapterReads.clients = clients.length
  const project = projects[0]
  if (project) {
    assertMeta(await adapter.getProject(workspaceId, project.id), 'project')
    const labor = await adapter.getProjectLabor(workspaceId, project.id); assertMeta(labor, 'project_labor'); out.adapterReads.projectLaborEntries = labor.entryCount
    out.adapterReads.projectWorkers = (await adapter.getProjectWorkers(workspaceId, project.id)).length
    const estimates = await adapter.listProjectEstimates(workspaceId, project.id); estimates.forEach(x => assertMeta(x, 'estimate')); out.adapterReads.projectEstimates = estimates.length
    if (estimates[0]) assertMeta(await adapter.getEstimate(workspaceId, estimates[0].id), 'estimate')
    const pos = await adapter.listProjectPurchaseOrders(workspaceId, project.id); pos.forEach(x => assertMeta(x, 'purchase_order')); out.adapterReads.projectPurchaseOrders = pos.length
    if (pos[0]) { assertMeta(await adapter.getPurchaseOrder(workspaceId, pos[0].id), 'purchase_order'); assertMeta(await adapter.getVendor(workspaceId, pos[0].vendorId), 'vendor') }
    const receipts = await adapter.listProjectReceipts(workspaceId, project.id); receipts.forEach(x => assertMeta(x, 'receipt')); out.adapterReads.projectReceipts = receipts.length
  }
  const workerRow = await q('workers:id WHERE company_id=configured company LIMIT 1', () => client.from('workers').select('id').eq('company_id', companyId).limit(1).maybeSingle())
  if (workerRow?.data) assertMeta(await adapter.getWorker(workspaceId, workerRow.data.id), 'worker')
  const periodRow = await q('pay_periods:id WHERE company_id=configured company ORDER created_at DESC LIMIT 1', () => client.from('pay_periods').select('id').eq('company_id', companyId).order('created_at', { ascending: false }).limit(1).maybeSingle())
  if (periodRow?.data) assertMeta(await adapter.getPayrollSummary(workspaceId, periodRow.data.id), 'payroll_summary')
}

for (const table of ['projects','clients','workers','time_entries','pay_periods','payroll_entries','estimates','purchase_orders','vendors','receipts']) {
  const r = await q(`${table}:count WHERE company_id=configured company`, () => client.from(table).select('id', { count: 'exact', head: true }).eq('company_id', companyId))
  out.counts[table] = dryRun ? null : r.count
}
const pos = await q('purchase_orders:id,company_id,status,updated_at WHERE company_id=configured company ORDER updated_at,id', () => client.from('purchase_orders').select('id,company_id,status,updated_at').eq('company_id', companyId).order('updated_at').order('id'))
if (!dryRun) {
  const rows = pos.data
  out.poCursor.count = rows.length
  out.poCursor.companyScoped = rows.every(r => r.company_id === companyId)
  out.poCursor.ordered = rows.every((r,i) => i === 0 || rows[i-1].updated_at < r.updated_at || (rows[i-1].updated_at === r.updated_at && rows[i-1].id <= r.id))
  out.poCursor.timestamps = rows.map(r => r.updated_at)
  out.poCursor.statuses = Object.fromEntries([...new Set(rows.map(r=>r.status))].sort().map(s => [s, rows.filter(r=>r.status===s).length]))
  out.poCursor.overlap = 'inclusive notBefore overlap plus strict (updated_at,id) seek is required; de-duplication must key the source row identity/cursor pair'
}
out.sensitiveFieldAudit.adapterExposes = ['worker:firstName,lastName,status,workerType,hourlyRate','payroll_summary:aggregates only','receipt:no raw OCR','no NIB/TIN/banking/deduction fields']

const text = JSON.stringify(out, null, 2)
process.stdout.write(json ? `${text}\n` : `Bedrock read-only smoke\n${text}\n`)
