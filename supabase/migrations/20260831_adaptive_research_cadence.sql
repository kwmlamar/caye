-- Tune continuous research to favor frequent, shallow investigations.
-- Material developments accelerate follow-up while quieter desks run less often.

update research_desks
set
  cadence = case desk_key
    when 'ai-global-technology' then '{"intervalMinutes":90,"materialChangeIntervalMinutes":30}'::jsonb
    when 'career-economy' then '{"intervalMinutes":150,"materialChangeIntervalMinutes":45}'::jsonb
    when 'markets-business-capital' then '{"intervalMinutes":90,"materialChangeIntervalMinutes":30}'::jsonb
    when 'wildcard-global-discovery' then '{"intervalMinutes":240,"materialChangeIntervalMinutes":60}'::jsonb
    else cadence
  end,
  exploration_budget = jsonb_set(
    jsonb_set(exploration_budget, '{maxQueries}', '1'::jsonb, true),
    '{timeoutMs}', '240000'::jsonb, true
  ),
  updated_at = now()
where desk_key in (
  'ai-global-technology',
  'career-economy',
  'markets-business-capital',
  'wildcard-global-discovery'
);

-- A cycle can produce real durable research and still end as partial or
-- budget_exhausted because a later follow-up ran out of time. Treat the latest
-- cycle that actually persisted sources as successful research history.
with last_good as (
  select desk_id, max(completed_at) as last_good_at
  from research_desk_cycles
  where coalesce((budget_usage->>'sources')::int, 0) > 0
    and status <> 'failed'
  group by desk_id
)
update research_desks d
set
  last_successful_research = greatest(
    coalesce(d.last_successful_research, 'epoch'::timestamptz),
    last_good.last_good_at
  ),
  updated_at = now()
from last_good
where d.id = last_good.desk_id;
