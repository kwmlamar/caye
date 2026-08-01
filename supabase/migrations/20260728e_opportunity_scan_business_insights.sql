-- Opportunity Scan + Business Insights (2026-07-28) — proactive back-office
-- crons. Both default OFF; opportunity_scan_enabled is flipped on for
-- Bimini only at launch.
--
-- last_opportunity_scan_summary/_at are per-workspace state, not global
-- cron health (that's caye_cron_runs, a single row per cron_name) — so
-- the opportunity-scan cron can tell Caye what she already flagged last
-- time and avoid re-nagging. Mirrors the existing last_eod_sent_at column
-- shape on this same table.
ALTER TABLE workspace_ai_config
  ADD COLUMN opportunity_scan_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN last_opportunity_scan_at timestamptz,
  ADD COLUMN last_opportunity_scan_summary text,
  ADD COLUMN business_insights_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN last_business_insights_sent_at timestamptz;
