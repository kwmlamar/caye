-- Mission funnel measurement tables
-- Tracks employment and revenue outcomes, enables bottleneck detection and intelligence generation
-- PR: Make employment and revenue outcome-driven missions
-- 2026-08-31

-- Outreach tracker: canonical log of all Caye customer acquisition outreach
-- Replaces ad-hoc markdown tracking with structured funnel data
CREATE TABLE IF NOT EXISTS outreach_tracker (
  id BIGSERIAL PRIMARY KEY,

  -- Prospect identification
  prospect_name TEXT NOT NULL,
  prospect_business TEXT NOT NULL,
  island_region TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  contact_method TEXT, -- 'whatsapp', 'email', 'dm', 'call'

  -- Qualification and send
  qualified BOOLEAN DEFAULT false,
  sent_at TIMESTAMP NOT NULL,
  sender_email TEXT DEFAULT 'hello@getcaye.com',
  message_preview TEXT,

  -- Tracking
  reached BOOLEAN DEFAULT NULL, -- message was delivered/seen
  response_status TEXT DEFAULT NULL, -- 'replied', 'positive', 'cold', NULL for no response yet
  response_at TIMESTAMP,
  response_text TEXT,

  -- Conversion
  demo_scheduled BOOLEAN DEFAULT false,
  demo_date TIMESTAMP,
  customer_id BIGINT REFERENCES customers(id),

  -- Metadata
  icp_segment TEXT, -- 'tour_operator', 'restaurant', 'salon', 'guesthouse', etc
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_sent_at ON outreach_tracker(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_qualified ON outreach_tracker(qualified);
CREATE INDEX IF NOT EXISTS idx_outreach_response_status ON outreach_tracker(response_status);
CREATE INDEX IF NOT EXISTS idx_outreach_customer ON outreach_tracker(customer_id);

-- Trigger for outreach_tracker updated_at
CREATE OR REPLACE FUNCTION update_outreach_tracker_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outreach_tracker_updated_at ON outreach_tracker;
CREATE TRIGGER outreach_tracker_updated_at
  BEFORE UPDATE ON outreach_tracker
  FOR EACH ROW
  EXECUTE FUNCTION update_outreach_tracker_updated_at();

-- Employment mission funnel: track job search outcomes and rates
CREATE TABLE IF NOT EXISTS employment_mission_weekly (
  id BIGSERIAL PRIMARY KEY,
  week_ending DATE NOT NULL UNIQUE,

  -- Discovered → Qualified funnel
  jobs_discovered INT DEFAULT 0,
  jobs_qualified INT DEFAULT 0,
  qualification_rate_pct NUMERIC(5,2),

  -- Prepared → Submitted funnel
  applications_attempted INT DEFAULT 0,
  applications_submitted INT DEFAULT 0,
  submission_success_rate_pct NUMERIC(5,2),

  -- Response funnel
  responses_received INT DEFAULT 0,
  response_rate_pct NUMERIC(5,2),
  positive_responses INT DEFAULT 0,
  positive_response_rate_pct NUMERIC(5,2),

  -- Interview funnel
  screens_scheduled INT DEFAULT 0,
  screen_to_interview_rate_pct NUMERIC(5,2),
  interviews_completed INT DEFAULT 0,
  interview_to_offer_rate_pct NUMERIC(5,2),

  -- Outcome
  offers_received INT DEFAULT 0,

  -- Analysis
  primary_bottleneck TEXT,
  bottleneck_inference TEXT,
  recommended_action TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CHECK (qualification_rate_pct BETWEEN 0 AND 100),
  CHECK (submission_success_rate_pct BETWEEN 0 AND 100),
  CHECK (response_rate_pct BETWEEN 0 AND 100),
  CHECK (positive_response_rate_pct BETWEEN 0 AND 100),
  CHECK (screen_to_interview_rate_pct BETWEEN 0 AND 100),
  CHECK (interview_to_offer_rate_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_employment_mission_week ON employment_mission_weekly(week_ending DESC);

-- Revenue mission funnel: track Caye customer acquisition and rates
CREATE TABLE IF NOT EXISTS revenue_mission_weekly (
  id BIGSERIAL PRIMARY KEY,
  week_ending DATE NOT NULL UNIQUE,

  -- Discovered → Qualified funnel
  prospects_discovered INT DEFAULT 0,
  prospects_qualified INT DEFAULT 0,
  qualification_rate_pct NUMERIC(5,2),

  -- Qualified → Contacted funnel
  contacts_attempted INT DEFAULT 0,
  contacts_successful INT DEFAULT 0,
  contact_success_rate_pct NUMERIC(5,2),

  -- Contact → Reply funnel
  replies_received INT DEFAULT 0,
  reply_rate_pct NUMERIC(5,2),
  positive_replies INT DEFAULT 0,
  positive_reply_rate_pct NUMERIC(5,2),

  -- Reply → Demo funnel
  demos_scheduled INT DEFAULT 0,
  demo_conversion_rate_pct NUMERIC(5,2),

  -- Demo → Customer funnel
  customers_acquired INT DEFAULT 0,
  customer_conversion_rate_pct NUMERIC(5,2),
  mrr_new NUMERIC(10,2) DEFAULT 0,
  mrr_cumulative NUMERIC(10,2),

  -- Analysis
  primary_bottleneck TEXT,
  bottleneck_inference TEXT,
  recommended_action TEXT,

  -- Input metric tracking (non-negotiable from goals)
  outreach_sends_this_week INT,
  outreach_sends_target INT,
  outreach_on_track BOOLEAN,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CHECK (qualification_rate_pct BETWEEN 0 AND 100),
  CHECK (contact_success_rate_pct BETWEEN 0 AND 100),
  CHECK (reply_rate_pct BETWEEN 0 AND 100),
  CHECK (positive_reply_rate_pct BETWEEN 0 AND 100),
  CHECK (demo_conversion_rate_pct BETWEEN 0 AND 100),
  CHECK (customer_conversion_rate_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_revenue_mission_week ON revenue_mission_weekly(week_ending DESC);

-- Funnel intelligence: canonical recommendations derived from funnel performance
CREATE TABLE IF NOT EXISTS funnel_intelligence (
  id BIGSERIAL PRIMARY KEY,
  mission TEXT NOT NULL, -- 'employment' or 'revenue'
  week_ending DATE NOT NULL,

  -- What funnel segment is the problem?
  segment_name TEXT NOT NULL, -- e.g., 'reply_rate', 'submission_success', 'contact_success'
  segment_rate_pct NUMERIC(5,2),
  benchmark_pct NUMERIC(5,2),
  variance_pct NUMERIC(5,2),

  -- Root cause hypothesis
  root_cause TEXT,
  confidence TEXT, -- 'high', 'medium', 'low'

  -- What should change?
  recommended_lever TEXT, -- what to change (messaging, targeting, etc.)
  priority INT, -- 1 = highest impact, 2 = secondary, etc.

  -- Metadata
  derived_from TEXT, -- which weekly record generated this
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(mission, week_ending, segment_name)
);

CREATE INDEX IF NOT EXISTS idx_funnel_intelligence_mission ON funnel_intelligence(mission, week_ending DESC);

-- Update triggers
CREATE OR REPLACE FUNCTION update_employment_mission_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employment_mission_updated_at ON employment_mission_weekly;
CREATE TRIGGER employment_mission_updated_at
  BEFORE UPDATE ON employment_mission_weekly
  FOR EACH ROW
  EXECUTE FUNCTION update_employment_mission_updated_at();

CREATE OR REPLACE FUNCTION update_revenue_mission_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_mission_updated_at ON revenue_mission_weekly;
CREATE TRIGGER revenue_mission_updated_at
  BEFORE UPDATE ON revenue_mission_weekly
  FOR EACH ROW
  EXECUTE FUNCTION update_revenue_mission_updated_at();

-- Permissions
GRANT SELECT ON outreach_tracker TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON outreach_tracker TO service_role;

GRANT SELECT ON employment_mission_weekly TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON employment_mission_weekly TO service_role;

GRANT SELECT ON revenue_mission_weekly TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON revenue_mission_weekly TO service_role;

GRANT SELECT ON funnel_intelligence TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON funnel_intelligence TO service_role;

-- RLS (service-role-only write)
ALTER TABLE outreach_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_mission_weekly ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_mission_weekly ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY outreach_tracker_read ON outreach_tracker FOR SELECT USING (true);
CREATE POLICY outreach_tracker_write ON outreach_tracker FOR INSERT, UPDATE USING (auth.role() = 'service_role');

CREATE POLICY employment_mission_read ON employment_mission_weekly FOR SELECT USING (true);
CREATE POLICY employment_mission_write ON employment_mission_weekly FOR INSERT, UPDATE USING (auth.role() = 'service_role');

CREATE POLICY revenue_mission_read ON revenue_mission_weekly FOR SELECT USING (true);
CREATE POLICY revenue_mission_write ON revenue_mission_weekly FOR INSERT, UPDATE USING (auth.role() = 'service_role');

CREATE POLICY funnel_intelligence_read ON funnel_intelligence FOR SELECT USING (true);
CREATE POLICY funnel_intelligence_write ON funnel_intelligence FOR INSERT, UPDATE USING (auth.role() = 'service_role');
