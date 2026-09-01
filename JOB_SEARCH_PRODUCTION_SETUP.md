# Caye Job-Search Production Setup & Troubleshooting

**Status:** System is BUILT but NOT SCHEDULED. Manual triggers work. Autonomous flow requires external scheduler configuration.

## Current State (2026-08-31)

The job-search system has all building blocks in place:
- ✅ Job sourcing from Greenhouse & Lever
- ✅ Candidate scoring against founder profile
- ✅ Application preparation with resume selection
- ✅ ATS form discovery and field population
- ✅ Greenhouse browser-based submission
- ✅ Daily cap & rollout controls
- ✅ Standing authorization for autonomous applications
- ✅ Comprehensive audit trails

**But:** No external scheduler is registered. All routes and crons are manual-trigger only.

## To Get Autonomous Job Applications Flowing

### Step 1: Verify Configuration (Foundation Check)

Before scheduling anything, verify these prerequisites exist:

```sql
-- Check if Greenhouse source is configured
SELECT * FROM job_search_sources WHERE enabled = true;

-- Check if founder profile exists
SELECT * FROM job_search_profile LIMIT 1;

-- Check if resume variants are verified
SELECT * FROM job_search_resume_variants WHERE status = 'verified' AND is_active = true;

-- Check standing authorization exists and is active
SELECT * FROM job_search_standing_authorizations 
WHERE revoked_at IS NULL 
ORDER BY created_at DESC LIMIT 1;
```

If any of these return empty, see **Configuration Gaps** below.

### Step 2: Enable External Scheduling

The cron routes are registered in the Admin Shell (`trigger_cron` tool in Caye Direct) but not scheduled. To run autonomously:

#### Option A: cron-job.org (Recommended)
1. Create a free account at https://cron-job.org
2. Register these jobs with your deployment URL and `CRON_SECRET`:

```
Job 1: Job-search sourcing (daily 08:00 UTC)
  URL: https://your-domain.com/api/caye/job-search-sourcing
  Header: x-cron-secret: [CRON_SECRET from .env.local]
  
Job 2: Job-search preparation (daily 09:00 UTC, 1 hour later)
  URL: https://your-domain.com/api/caye/job-search-prepare
  Header: x-cron-secret: [CRON_SECRET from .env.local]
  
Job 3: Job-search inspection (daily 09:30 UTC, 30 min after prep)
  URL: https://your-domain.com/api/caye/job-search-inspect
  Header: x-cron-secret: [CRON_SECRET from .env.local]
  
Job 4: Autonomous applications (daily 10:00 UTC, after inspection)
  URL: https://your-domain.com/api/caye/job-search-apply
  Header: x-cron-secret: [CRON_SECRET from .env.local]
```

**Note:** Stagger these by 30-60 min so each completes before the next starts. The job-search-apply must run AFTER inspection completes.

#### Option B: Vercel Cron (if deployed on Vercel)
Vercel doesn't have built-in cron yet, but you can use Vercel Functions with cron expressions in a separate orchestrator.

### Step 3: Verify Scheduler is Working

After registering with cron-job.org:

1. Check logs: Look for successful `2xx` responses from cron-job.org
2. Verify database activity:
   ```sql
   SELECT * FROM job_search_runs 
   ORDER BY created_at DESC LIMIT 5;
   ```
3. Monitor application generation:
   ```sql
   SELECT COUNT(*) as prepared_today FROM job_search_applications 
   WHERE status = 'PREPARED' 
   AND prepared_at > NOW() - INTERVAL '1 day';
   ```

### Step 4: Set Standing Authorization

Standing authorization is what enables autonomous applications. Set it via Caye Direct:

```
Caye: "enable autonomous job applications"

Founder: "approve up to 10 applications per day, min fit score 65, Greenhouse only"

Caye: [records standing authorization, enables autonomous applications]
```

Or manually:
```sql
INSERT INTO job_search_standing_authorizations (
  max_applications_per_day,
  min_fit_score,
  allowed_providers,
  pause_on_submission_uncertain,
  created_at
) VALUES (
  10,                    -- start conservative, scale up after 1-2 weeks of real applications
  65,                    -- match your sourcing threshold
  ARRAY['greenhouse'],   -- only automated providers
  true,                  -- pause if any submission is uncertain
  NOW()
);
```

## Testing the Flow Manually (Before Scheduling)

### Test 1: Source Jobs
```
Caye Direct → trigger_cron('job-search-sourcing')
```
Check database:
```sql
SELECT COUNT(*) as candidates_found FROM job_search_candidates 
WHERE status IN ('QUEUED', 'HUMAN_REVIEW', 'REJECTED')
AND discovered_at > NOW() - INTERVAL '1 minute';
```

### Test 2: Prepare Applications
```
Caye Direct → trigger_cron('job-search-prepare')
```
Check database:
```sql
SELECT COUNT(*) as applications_prepared FROM job_search_applications 
WHERE status IN ('PREPARED', 'NEEDS_HUMAN')
AND prepared_at > NOW() - INTERVAL '1 minute';
```

### Test 3: Inspect & Resolve Fields
```
Caye Direct → trigger_cron('job-search-inspect')
```
Check database:
```sql
SELECT COUNT(*) as applications_ready FROM job_search_applications 
WHERE status = 'PREPARED'
AND needs_human_reason IS NULL;
```

### Test 4: Autonomous Application (Dry Run)
```
Caye Direct → enable_dry_run_mode()
Caye Direct → trigger_cron('job-search-apply')
```
Check logs/database for what WOULD have been submitted without actually submitting.

### Test 5: Autonomous Application (Live)
```
Caye Direct → disable_dry_run_mode()
Caye Direct → preview_qualified_jobs()   # See what would be submitted
Caye Direct → apply_to_qualified_jobs(max_applications: 1, min_score: 65)
```

Watch in real-time:
```sql
SELECT * FROM job_search_execution_attempts 
ORDER BY created_at DESC LIMIT 5;

SELECT * FROM job_search_applications 
WHERE status = 'SUBMITTED'
AND submitted_at > NOW() - INTERVAL '5 minutes';
```

## Configuration Gaps

### Missing Greenhouse Source

If `job_search_sources` is empty, register your Greenhouse job boards:

```sql
INSERT INTO job_search_sources (
  source_key,
  adapter_type,
  display_name,
  enabled,
  config
) VALUES (
  'greenhouse_your_company',
  'greenhouse',
  'YourCompany Careers (Greenhouse)',
  true,
  jsonb_build_object(
    'boardToken', 'YOUR_BOARD_TOKEN',
    'apiUrl', 'https://api.greenhouse.io'
  )
);
```

Get `boardToken` from Greenhouse: Settings → Integrations → Job Board → Public Board Token

### Missing Founder Profile

Initialize Lamar's profile:

```sql
INSERT INTO job_search_profile (
  full_name,
  contact_email,
  contact_phone,
  target_titles,
  skills,
  years_of_experience,
  location_preferences,
  education
) VALUES (
  'Lamar Sineus',
  'lamar@tropitechsolutions.com',
  '+1234567890',
  ARRAY['Full Stack Engineer', 'Backend Engineer', 'AI/ML Engineer'],
  ARRAY['TypeScript', 'Python', 'React', 'PostgreSQL', 'AWS'],
  5,
  jsonb_build_object(
    'open_to_relocation', false,
    'open_to_remote_only', true,
    'preferred_locations', ARRAY['Remote', 'New York', 'San Francisco']
  ),
  ARRAY['BS Computer Science']
);
```

### Missing Resume Variants

Create verified resume variants:

```sql
INSERT INTO job_search_resume_variants (
  variant_key,
  title,
  status,
  is_active,
  summary,
  sections
) VALUES (
  'full_stack',
  'Full Stack Engineer Resume',
  'verified',
  true,
  'Full-stack engineer with 5+ years...',
  jsonb_build_object(
    'experience', ARRAY[...],
    'skills', ARRAY[...],
    'projects', ARRAY[...]
  )
);
```

Resume variants need to be manually created and marked as `verified: true` before the system will use them.

## Troubleshooting

### No candidates found after sourcing
- **Check:** Is Greenhouse source enabled and token valid?
  ```sql
  SELECT * FROM job_search_sources;
  ```
- **Check:** Recent errors in job_search_events?
  ```sql
  SELECT * FROM job_search_events 
  WHERE event_type LIKE '%failed%' OR event_type LIKE '%error%'
  ORDER BY created_at DESC LIMIT 10;
  ```
- **Action:** Test Greenhouse API token by hitting it directly
  ```bash
  curl https://api.greenhouse.io/v1/job_board/YOUR_TOKEN/jobs
  ```

### Applications not being prepared
- **Check:** Are there QUEUED candidates?
  ```sql
  SELECT COUNT(*) FROM job_search_candidates WHERE status = 'QUEUED';
  ```
- **Check:** Are there verified resume variants?
  ```sql
  SELECT * FROM job_search_resume_variants 
  WHERE status = 'verified' AND is_active = true;
  ```
- **Action:** Manually trigger preparation and check job_search_runs for errors:
  ```sql
  SELECT * FROM job_search_runs 
  WHERE run_type = 'apply'
  ORDER BY created_at DESC LIMIT 1;
  ```

### Applications prepared but not submitted
- **Check:** Is automation enabled?
  ```sql
  SELECT * FROM job_search_rollout_settings 
  ORDER BY updated_at DESC LIMIT 1;
  ```
- **Check:** Is there a standing authorization?
  ```sql
  SELECT * FROM job_search_standing_authorizations 
  WHERE revoked_at IS NULL;
  ```
- **Check:** Is daily cap exhausted?
  ```sql
  SELECT COUNT(*) FROM job_search_applications 
  WHERE status IN ('SUBMITTED', 'SUBMISSION_UNCERTAIN')
  AND submitted_at > NOW() - INTERVAL '1 day';
  ```
- **Action:** Check autonomous cycle logs:
  ```sql
  SELECT * FROM job_search_execution_attempts 
  ORDER BY created_at DESC LIMIT 10;
  ```

### Submissions coming back as UNCERTAIN
- **Action:** Emergency pause applications
  ```
  Caye Direct → pause_job_search()
  ```
- **Investigate:** Check the execution attempt to see what happened:
  ```sql
  SELECT * FROM job_search_execution_attempts 
  WHERE outcome = 'submission_uncertain'
  ORDER BY created_at DESC LIMIT 1;
  ```
- **Resume:** Once reconciled:
  ```
  Caye Direct → resume_job_search()
  ```

## Monitoring (Weekly)

### Applications submitted this week
```sql
SELECT 
  DATE(submitted_at) as day,
  COUNT(*) as submissions,
  COUNT(CASE WHEN status = 'SUBMITTED' THEN 1 END) as confirmed,
  COUNT(CASE WHEN status = 'SUBMISSION_UNCERTAIN' THEN 1 END) as uncertain
FROM job_search_applications
WHERE submitted_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(submitted_at)
ORDER BY day DESC;
```

### Application status distribution
```sql
SELECT 
  status,
  COUNT(*) as count
FROM job_search_applications
GROUP BY status
ORDER BY count DESC;
```

### Average fit score of queued candidates
```sql
SELECT 
  AVG(fit_score) as avg_score,
  MIN(fit_score) as min_score,
  MAX(fit_score) as max_score
FROM job_search_candidates
WHERE status = 'QUEUED';
```

## Next Steps

1. **This week:** Register with cron-job.org, verify configuration
2. **Week 2:** Run manual tests in order (sourcing → prep → inspect → apply)
3. **Week 3:** Enable 1-2 autonomous applications/day, monitor carefully
4. **Week 4+:** Scale up to 5-10/day, add Gmail reply correlation

## References

- Code: `lib/job-search/`, `app/api/caye/job-search-*`
- Standing authorization: `lib/job-search/standing-authorization.ts`
- Autonomous executor: `lib/job-search/execution/autonomy.ts`
- Batch operations: `lib/job-search/execution/batch.ts`
