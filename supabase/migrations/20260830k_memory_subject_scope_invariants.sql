-- Forward hotfix for production databases where 20260830d_persistent_operating_memory.sql
-- may already have been applied before subject-scope invariants were added there.
-- Fresh databases still receive the same invariant from the original migration.

do $$ begin
  alter table public.business_facts add constraint business_facts_subject_scope_check
    check (
      (subject_type = 'workspace' and subject_id is null and service_id is null)
      or (subject_type = 'service' and service_id is not null and subject_id = service_id::text)
      or (subject_type not in ('workspace','service') and service_id is null and nullif(btrim(subject_id),'') is not null)
    );
exception when duplicate_object then null; end $$;

comment on constraint business_facts_subject_scope_check on public.business_facts is
  'Prevents typed memory subject metadata from widening or contradicting legacy service scope.';
