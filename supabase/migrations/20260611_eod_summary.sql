-- End-of-day summary opt-in (slice #44 of epic #35).
-- Default OFF — many operators already get noisy notifications and the
-- briefing covers the morning side. The EOD is for operators who
-- specifically want a recap at the end of their day.
ALTER TABLE workspace_ai_config
  ADD COLUMN eod_summary_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN eod_summary_time time DEFAULT '20:00:00',
  ADD COLUMN last_eod_sent_at timestamptz;
