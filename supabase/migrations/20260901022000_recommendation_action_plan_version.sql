-- Recommendation execution approvals must be invalidated when the structured
-- action plan changes, even when the human-readable recommendation text does not.
-- The plan itself remains advisory until deterministic runtime validation.

create or replace function public.caye_recommendation_version(p_recommendation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(digest(concat_ws('|',
    'caye-recommendation-decision-version-v2',
    r.fingerprint,
    r.recommendation,
    r.expected_impact,
    r.urgency,
    r.reversibility,
    r.risk_classification,
    r.required_authority::text,
    coalesce(r.provenance->'actionPlan', 'null'::jsonb)::text,
    coalesce(r.provenance->>'actionPlanFingerprint', '')
  ), 'sha256'), 'hex')
  from public.caye_recommendations r
  where r.id = p_recommendation_id;
$$;

revoke all on function public.caye_recommendation_version(uuid) from public, anon, authenticated;
grant execute on function public.caye_recommendation_version(uuid) to service_role;

comment on function public.caye_recommendation_version(uuid) is
  'Pins recommendation decisions and queued execution to recommendation content plus its validated structured action plan.';
