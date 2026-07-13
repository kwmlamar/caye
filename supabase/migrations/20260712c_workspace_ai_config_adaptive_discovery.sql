-- Discovery interview is becoming adaptive (grill-me-style: ask one thing
-- at a time, stop as soon as there's enough, capped ~10 questions) instead
-- of a fixed 9-question script. onboarding_wa_answers now holds an ordered
-- { question, answer }[] transcript instead of a fixed-key map — no
-- migration needed for that column itself (untyped jsonb), but the
-- question text is now generated dynamically each turn rather than looked
-- up by a fixed index, so it needs to be persisted somewhere to know what
-- an incoming answer is responding to.

alter table public.workspace_ai_config
  add column onboarding_wa_last_question text;

alter table public.workspace_ai_config
  alter column onboarding_wa_answers set default '[]'::jsonb;
