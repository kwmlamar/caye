create unique index if not exists job_search_generated_artifacts_application_type_key
  on public.job_search_generated_artifacts(application_id, artifact_type);

create unique index if not exists job_search_application_answers_application_question_key
  on public.job_search_application_answers(application_id, question);
