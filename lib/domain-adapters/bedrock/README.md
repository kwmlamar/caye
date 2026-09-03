# Bedrock / TropiTrack domain adapter

This module is a **read-only** boundary from Caye into Bedrock/TropiTrack. Bedrock remains authoritative for construction operational state; returned values are external authoritative snapshots, not Caye business facts.

## Live production audit (2026-09-01)

Production was inspected directly because repository migrations have drifted from the live database.

Operational row counts at audit time: 25 projects, 14 clients, 20 workers, 3,873 time entries, 35 pay periods, 365 payroll entries, 25 estimates, 13 purchase orders, 6 receipts, 5 vendors, 0 invoices, 0 invoice payments, and 186 audit logs.

Core relationships confirmed by live foreign keys:

- projects -> clients
- time_entries -> projects + workers + companies
- payroll_entries -> pay_periods + workers + companies
- estimates -> projects
- purchase_orders -> projects + vendors + companies
- purchase_order_items -> purchase_orders
- receipts -> projects; receipt_line_items -> receipts + materials
- invoices -> projects + clients + companies; payments -> invoices

`purchase_order_items.material_id` is present but has no live foreign key to `materials`; the adapter therefore preserves PO item description and financial fields without asserting a material relationship.

Current live status constraints:

- projects: planning, active, on_hold, completed, cancelled
- workers: active, inactive, terminated
- estimates: draft, sent, approved, rejected
- purchase_orders: draft, submitted, approved, ordered, partial_received, received, cancelled
- receipts: pending, processed, failed
- pay_periods: open, processing, paid, cancelled
- payroll_entries.payment_status: unpaid, partial, paid
- vendors: active, inactive, blacklisted
- invoices: draft, sent, viewed, paid, partial, overdue, cancelled, void

At audit time production contained 14 active / 6 completed / 5 planning projects; all 25 estimates were draft; 12 of 13 POs were received; all 6 receipts were processed; payroll entries were 310 paid / 30 partial / 25 unpaid.

## Repository vs production discrepancies

`supabase/migrations/20260604_enable_rls_on_orphan_tables.sql` enables RLS and adds policies for estimates, estimate sections/lines, receipts, receipt lines, materials, and other orphan tables. Production still has RLS disabled on `estimates`, `estimate_sections`, `estimate_line_items`, `receipts`, `receipt_line_items`, and `materials`. Do not assume repository migration state equals production.

The live `materials.id` and `receipt_line_items.material_id` are text and are linked by an FK. `purchase_order_items.material_id` is UUID and is not linked by a live FK. Treat that field as non-authoritative until Bedrock reconciles the schema.

Although several top-level company_id columns are nullable in DDL, every current project, client, worker, vendor, and purchase order row had a company_id at audit time. All 39 cost_catalog rows were unscoped; cost catalog is intentionally unsupported by this adapter version.

Invoices and invoice payments exist structurally but had zero production rows at audit time.

## Tenant mapping

The adapter consumes a `BedrockConnectionResolver`:

Caye workspace -> Bedrock domain connection -> Bedrock company.

No ODS or other tenant UUID is hard-coded. Tenant binding lives in the kernel's `domain_source_connections` table and is read by `KernelBedrockConnectionResolver`: `external_tenant_id` is the Bedrock company id, `config.supabase_url` is non-secret configuration, and `credential_ref` names a secret that `lib/domain/secrets.ts` materialises from `DOMAIN_SECRET_*` at client-construction time. The transitional `EnvBedrockConnectionResolver` (`BEDROCK_CONNECTIONS_JSON`) it replaced has been removed, so there is exactly one tenant-binding path and no service-role key in an environment JSON blob.

Example shape (values belong in deployment secrets, never source control):

```json
[
  {
    "workspaceId": "...",
    "companyId": "...",
    "supabaseUrl": "...",
    "serviceRoleKey": "..."
  }
]
```

The credential payload is stored in a native private field so ordinary serialization cannot emit it.

## Security model

- All implementation files import `server-only`.
- The model/runtime is not given arbitrary SQL or raw table access.
- The Supabase provider exposes only fixed read primitives.
- Every top-level tenant-owned lookup is constrained by the mapped company ID.
- Entity IDs from another company resolve as not-found.
- Child tables without company_id are queried only after their company-scoped parent is validated.
- Missing or ambiguous connection mappings fail closed.
- Sensitive worker identifiers, NIB data, vendor account/TIN fields, payroll deduction details, receipt OCR text, and company banking/payment fields are not normalized into adapter output.
- The adapter contains no mutation methods.
- Bedrock RLS is treated as defense-in-depth, not the adapter's primary isolation mechanism, because live RLS state is inconsistent.

## API

- health
- listProjects / findProjects / getProject
- listClients / findClients / getClient
- getWorker
- getProjectWorkers / getProjectLabor
- getPayrollSummary
- listPayPeriods / getPayrollOwed
- getEstimate / listProjectEstimates
- getPurchaseOrder / listProjectPurchaseOrders
- getVendor
- listProjectReceipts
- listInvoices / getInvoiceWithPayments

Every returned domain entity carries `sourceSystem=bedrock`, `authority=external_authoritative`, source entity type/id, Caye workspace ID, and Bedrock company ID.

## Existing Bedrock AI tooling

Bedrock contains an older class-based `ai-agent/tools/*` surface and a newer descriptor registry under `src/lib/ai-tools`. Useful concepts include fixed domain reads, company-scoped queries, payroll aggregation, tool descriptors, and audit/pending-write separation. Caye should reuse those domain semantics where correct, not the Bedrock model runtime or write tools.

Some older Bedrock AI code is weaker than this adapter boundary: for example project detail/cost helper queries do not consistently add company_id to every related query, and the registry includes write tools for payroll and worker state. Those write paths are deliberately not imported or reproduced here.

## Unsupported in v0

Payment transactions (mutation), project milestones/documents, daily timesheets, worker skills, payroll adjustments, materials/cost catalog, equipment/equipment usage, goals, exports/company docs, estimate labor-role internals, and Bedrock write operations.

Invoices and their payments are now read-supported (`listInvoices`, `getInvoiceWithPayments`), added for the ODS receivables loop (see `briefs/ods-receivables-loop.md`). `payments` has no `company_id` column of its own -- it only joins to an invoice -- so `listInvoicePayments` on the provider validates the invoice belongs to the caller's company before ever querying `payments`, per the child-table rule in the Security model section above. `BedrockInvoice` deliberately omits client contact fields and free-text notes/terms, matching the restraint `BedrockClient`/`BedrockVendor` already show.

## Agent 1 integration

Do not add generic business-entity migrations from this module. During integration, replace `BedrockConnectionResolver` with the generic kernel's domain-connection resolver and make the local authority/entity metadata conform to its final shared `DomainEntity` interface. Preserve Bedrock-specific typed fields and the read-only provider boundary.
