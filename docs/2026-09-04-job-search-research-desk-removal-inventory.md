# Inventory: full removal of job-search + research-desk + growth/perception subsystems

Companion to the 2026-09-04 stand-down of their crons (see `vercel.json` and the PR that
de-scheduled them). This is an inventory only — nothing here is deleted. It exists so a
future decision to actually remove this code is cheap to scope, not a recommendation to
do so.

## Job-search agent

**Routes** (`app/api/caye/`):
`job-search-sourcing`, `job-search-objective`, `job-search-prepare`, `job-search-apply`,
`job-search-inspect`, `job-search-email-poll`.

**Admin trigger wiring**: `lib/caye-agent/tools/admin/cron-registry.ts` imports
`runJobSearchSourcing`, `runJobSearchPreparation`, `runJobSearchInspection`, and wraps
`runStandingAutonomyCycle` for `job-search-apply`. `lib/caye-agent/tools/admin/admin-high-risk-gate.ts`
and `write-high/trigger-cron.ts` special-case these job names for founder-only no-confirmation
execution. Removing the routes means pulling these registry entries and the gate's
special-casing too, or the founder-admin agent will reference dead imports.

**`lib/job-search/`** — the whole tree (~70 files): sourcing/scoring (`scoring.ts`,
`ingest.ts`), execution/submission (`execution/*`, including the Greenhouse browser
provider, SSRF guard, submission gate, standing-authorization, claim/reservation logic),
email correlation (`email-correlation.ts`, `gmail-correlation.ts`, `founder-zoho.ts`),
resume tailoring, funnel metrics, and their tests.

**Tables**: `job_search_candidates` (983 rows — active founder job-search data, do not
touch), `job_search_runs`, `job_search_run_candidates`, `job_search_applications`,
`job_search_application_answers`, `job_search_batch_authorizations`, `job_search_events`,
`job_search_execution_attempts`, `job_search_execution_settings`,
`job_search_followups`, `job_search_generated_artifacts`, `job_search_profile_facts`,
`job_search_profiles`, `job_search_resume_variants`, `job_search_settings`,
`job_search_sources`, `job_search_submission_reservations`.

**Other references**: `next.config.ts` traces `job-search-apply`'s browser runtime files
for the Vercel bundle (`browserRuntimeFiles`) — that config entry becomes dead too.
`lib/job-search/execution/browser-runtime-tracing.test.ts` asserts the trace list.

## Research desk

**Routes**: `app/api/caye/research-worker`.

**Admin trigger wiring**: `cron-registry.ts` imports `runResearchWorker`.

**`lib/research/`** — the whole tree: desk definitions (`desks/ai-global-technology.ts`,
`desks/intelligence-priorities.ts`, `desks/runtime.ts`, `desks/supabase.ts`), providers
(`anthropic.ts`, `openai.ts`, `openrouter.ts`, `synthesis.ts`, `source-fetch.ts`), the
cross-domain runtime, investigation lifecycle, and founder-investigation-update
projection (this last piece is also imported from `lib/research/worker.ts` into founder
UI surfaces — check before cutting).

**Tables**: `research_runs` (97 rows), `research_briefs` (55), `research_claims` (466),
`research_claim_evidence`, `research_desk_cycles`, `research_desks`, `research_programs`,
`research_question_origins`, `research_questions`, `research_run_sources`,
`research_sources`.

## Growth intelligence

**Routes**: `app/api/caye/growth-ingest`.

**Admin trigger wiring**: `cron-registry.ts` imports `runGrowthIngest`.

**`lib/growth/`**: `diagnose.ts`, `ingest.ts`, `internal-evidence.ts`, `diagnosis-contract.ts`,
GA4 and Search Console providers.

**Tables**: `growth_diagnoses`, `growth_observations`, `growth_recommendations`,
`growth_sources`.

## Perception / event awareness

**Route**: `app/api/caye/perception-awareness` (calls the
`run_workspace_event_perception_cycle` Postgres RPC directly — no dedicated `lib/`
worker file, the logic lives in the migration-defined RPC).

**`lib/perception/`**: `policy.ts` plus migration-contract tests
(`domain-event-migration-contract.test.ts`, `domain-observation-catchup.test.ts`,
`migration-contract.test.ts`) that pin the RPC's behavior — a real removal has to also
decide whether to drop the RPC and its migration.

**Tables**: `perception_capability_evidence`, `perception_source_state`.

## Gmail observation discovery

**Route**: `app/api/caye/gmail-observation-discovery` — no dedicated `lib/` module; logic
is inline in the route file. Writes into `workspace_ai_config.metadata.gmail_observation_discovery`
and flips `connected_accounts.metadata.observation_discovery_status`. A real removal
needs to decide what happens to those metadata keys on existing rows, not just stop
writing them.

## Not inventoried here

`business-learning` (`app/api/cron/business-learning`, `lib/business-learning/`) was kept
scheduled in the 2026-09-04 stand-down — see that PR for why (it targets `business_facts`,
which live Bimini/ODS conversation paths read) — so it is out of scope for this inventory.
