-- AI & Global Technology Intelligence desk.
--
-- This is intentionally data on top of Research Runtime V1, not a parallel
-- research schema. The runtime remains the owner of runs, evidence, claims,
-- contradictions, temporal validity, and briefs.

insert into public.research_programs (goal_id, scope, title, status)
values (
  '00df8e47-cb52-43a6-8fca-4f8e31da101f',
  'operator',
  'AI & Global Technology Intelligence',
  'active'
)
on conflict (goal_id, title) do update
set status = 'active', updated_at = now();

with program as (
  select id
  from public.research_programs
  where goal_id = '00df8e47-cb52-43a6-8fca-4f8e31da101f'
    and title = 'AI & Global Technology Intelligence'
)
insert into public.research_questions (program_id, question, status)
select program.id, questions.question, 'open'
from program
cross join (
  values
    ('What became possible recently that was not realistically possible before?'),
    ('What capability is becoming dramatically cheaper?'),
    ('What previously difficult agent capability is becoming commodity infrastructure?'),
    ('What are frontier labs clearly building toward?'),
    ('What is China doing differently from the US?'),
    ('What important developments are occurring outside the US AI bubble?'),
    ('Which assumptions about agents/JARVIS are becoming obsolete?'),
    ('What should a builder stop implementing because providers are likely to commoditize it?'),
    ('What newly possible products/businesses exist because of recent advances?'),
    ('What developments materially change the timeline toward persistent personal AI or embodied intelligence?')
) as questions(question)
on conflict (program_id, question) do update
set status = case
  when public.research_questions.status = 'archived' then 'open'
  else public.research_questions.status
end,
updated_at = now();
