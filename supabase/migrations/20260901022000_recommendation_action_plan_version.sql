-- 2026-09-02 correction (never applied anywhere): the fingerprint helpers below
-- called bare digest(), which does not resolve under `set search_path = public`
-- because pgcrypto is installed in the `extensions` schema. The SQL-language
-- helpers failed at CREATE time, so this migration could not be applied at all.
-- Qualified as extensions.digest(...) rather than widening search_path, which
-- would broaden unqualified name resolution inside a SECURITY DEFINER body.
-- Safe to correct in place: this version has never been recorded in any
-- environment's ledger and none of its objects exist in production.

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
  select encode(extensions.digest(concat_ws('|',
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
