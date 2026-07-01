alter table workspace_ai_config
  add column if not exists onboarding_wa_question_index integer not null default 0,
  add column if not exists onboarding_wa_answers jsonb not null default '{}'::jsonb;

comment on column workspace_ai_config.onboarding_wa_question_index is 'Index into lib/onboarding.ts SERVICE_BUSINESS_QUESTIONS — tracks progress through the WhatsApp-native discovery grill.';
comment on column workspace_ai_config.onboarding_wa_answers is 'Answers collected so far during the WhatsApp discovery grill, keyed by question id. Superseded by raw_onboarding_answers once discovery completes.';
