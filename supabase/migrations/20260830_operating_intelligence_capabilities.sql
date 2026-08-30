-- Canonical Operating Intelligence capability layer for founder Direction.
-- Extends caye_goals instead of creating a parallel goal hierarchy.

create table if not exists public.caye_goal_capabilities (
  goal_id uuid primary key references public.caye_goals(id) on delete cascade,
  capability_key text not null unique,
  maturity_level integer not null default 0 check (maturity_level between 0 and 5),
  maturity_label text not null default 'FOUNDATION' check (maturity_label in ('FOUNDATION','ACTIVE','LIMITED','FUTURE')),
  current_state text,
  next_state text,
  blockers jsonb not null default '[]'::jsonb,
  last_assessed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.caye_goal_capability_assessments (
  id bigserial primary key,
  goal_id uuid not null references public.caye_goals(id) on delete cascade,
  maturity_level integer not null check (maturity_level between 0 and 5),
  maturity_label text not null check (maturity_label in ('FOUNDATION','ACTIVE','LIMITED','FUTURE')),
  rationale text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  assessed_by text not null,
  assessed_at timestamptz not null default now()
);
create index if not exists caye_goal_capability_assessments_goal_idx on public.caye_goal_capability_assessments(goal_id, assessed_at desc);

create table if not exists public.caye_goal_capability_evidence (
  id bigserial primary key,
  goal_id uuid not null references public.caye_goals(id) on delete cascade,
  evidence_type text not null check (evidence_type in ('code','migration','test','deployment','runtime','metric','document')),
  evidence_ref text not null,
  summary text not null,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(goal_id, evidence_type, evidence_ref)
);

create table if not exists public.caye_goal_capability_initiatives (
  capability_goal_id uuid not null references public.caye_goals(id) on delete cascade,
  initiative_goal_id uuid not null references public.caye_goals(id) on delete cascade,
  relationship text not null default 'advances' check (relationship in ('advances','depends_on','blocks')),
  created_at timestamptz not null default now(),
  primary key (capability_goal_id, initiative_goal_id, relationship),
  check (capability_goal_id <> initiative_goal_id)
);

with parent as (
  select id from public.caye_goals
  where scope='operator' and title='Increase Caye''s operational autonomy.' and superseded_at is null
  order by created_at asc limit 1
), capabilities(capability_key,title,description,status,priority,maturity_level,maturity_label,current_state,next_state) as (
  values
  ('perception_awareness','Perception & Continuous Awareness','Observe authorized operational state, normalize observations, detect meaningful change, and surface or act within authority.','active','critical',1,'FOUNDATION','Multiple proactive workers and channel observers exist, but perception is fragmented.','Unify observations, provenance, deduplication, change detection, severity, and interruption policy.'),
  ('memory_context','Memory & Context','Maintain durable typed context about people, organizations, properties, systems, decisions, procedures, corrections, assumptions, outcomes and prior work.','active','critical',2,'ACTIVE','Durable facts, standing rules, corrections and founder memory primitives exist.','Add typed operational memory, provenance, supersession, contradiction handling and outcome learning.'),
  ('research_intelligence','Research & Intelligence','Search, investigate, verify, synthesize and maintain evidence-backed knowledge with uncertainty and freshness.','active','high',2,'ACTIVE','Research workers and claim evidence primitives exist.','Unify research tasks, claims, evidence, contradiction tracking and refresh policies.'),
  ('reasoning_simulation','Reasoning & Simulation','Reason over state, compare alternatives and use simulations or models before high-impact decisions.','active','high',1,'FOUNDATION','Engineering analysis and simulation work exists, but general decision simulation is limited.','Add reusable decision models, uncertainty propagation and scenario comparison tied to objectives.'),
  ('planning_decomposition','Planning & Objective Decomposition','Convert objectives into bounded, resumable plans and task graphs grounded in current state.','active','critical',1,'FOUNDATION','Goals, jobs and workflow-specific planning exist.','Implement durable objective runs with explicit steps, budgets, timeouts, retries and replanning.'),
  ('tool_action_execution','Tool Use & Action Execution','Execute authorized actions through real tools with idempotency, verification, recovery and auditability.','active','critical',2,'ACTIVE','Caye already executes bookings, outreach, messaging, job-search and other tool-backed workflows.','Standardize authority-aware execution, effect verification, recovery and idempotency across workflows.'),
  ('verification_quality','Verification & Quality Control','Verify outputs and side effects against evidence rather than treating attempts as success.','active','high',1,'FOUNDATION','Some workflows have evidence and post-action checks.','Make verification first-class across runs with failure classification and quality gates.'),
  ('proactive_operations','Proactive Operations','Continuously identify and perform useful authorized work without waiting for direct prompts.','active','high',1,'FOUNDATION','Cron jobs, monitoring and proactive business workflows exist.','Tie proactive work to observations, goals, authority, interruption budgets and measurable outcomes.'),
  ('communication_coordination','Communication & Coordination','Coordinate with humans and systems across channels while preserving identity, context, authority and escalation boundaries.','active','high',2,'ACTIVE','WhatsApp, email, dashboard chat and founder/customer boundaries are established.','Unify cross-channel coordination, handoffs, escalation policy and conversation-to-operation linkage.'),
  ('adaptive_learning','Adaptive Learning','Learn from explicit corrections and outcomes without silently rewriting policy or expanding authority.','active','high',1,'FOUNDATION','Correction learning and durable facts exist.','Add typed learning loops with provenance, confidence, reversibility, contradiction handling and measured outcomes.'),
  ('engineering_build','Engineering & Build Capability','Design, implement, test and deploy software or technical artifacts in support of Caye objectives.','active','high',2,'ACTIVE','Engineering project execution and evidence primitives exist.','Connect engineering runs to Direction capabilities, verification evidence and deployment outcomes.'),
  ('physical_world','Physical World Interaction','Observe and eventually act through authorized physical sensors, devices, robotics and property systems.','future','medium',0,'FUTURE','Property modeling exists; physical sensing and actuation are not yet a general capability.','Establish safe sensor ingestion, digital twins, device authority boundaries and later robotics interfaces.')
), inserted as (
  insert into public.caye_goals(kind,parent_id,scope,workspace_id,title,description,status,priority,created_by_kind,created_by_label,source,rationale)
  select 'goal', p.id, 'operator', null, c.title, c.description, c.status, c.priority, 'system', 'operating-intelligence-capability-seed', 'seed:operating-intelligence-capabilities', 'Canonical capability roadmap under the existing operational autonomy objective.'
  from parent p cross join capabilities c
  where not exists (
    select 1 from public.caye_goals g where g.scope='operator' and g.title=c.title and g.superseded_at is null
  )
  returning id,title
)
insert into public.caye_goal_capabilities(goal_id,capability_key,maturity_level,maturity_label,current_state,next_state,last_assessed_at)
select g.id,c.capability_key,c.maturity_level,c.maturity_label,c.current_state,c.next_state,now()
from capabilities c
join public.caye_goals g on g.scope='operator' and g.title=c.title and g.superseded_at is null
on conflict (goal_id) do update set
  capability_key=excluded.capability_key,
  maturity_level=excluded.maturity_level,
  maturity_label=excluded.maturity_label,
  current_state=excluded.current_state,
  next_state=excluded.next_state,
  last_assessed_at=excluded.last_assessed_at,
  updated_at=now();

insert into public.caye_goal_capability_assessments(goal_id,maturity_level,maturity_label,rationale,evidence_refs,assessed_by)
select gc.goal_id,gc.maturity_level,gc.maturity_label,
  'Initial conservative assessment based on existing production architecture; capability claims require concrete evidence to advance.',
  '[]'::jsonb,
  'migration:20260830_operating_intelligence_capabilities'
from public.caye_goal_capabilities gc
where not exists (select 1 from public.caye_goal_capability_assessments a where a.goal_id=gc.goal_id);

-- Real code evidence for currently implemented primitives. These references prove existence, not full maturity.
insert into public.caye_goal_capability_evidence(goal_id,evidence_type,evidence_ref,summary,confidence)
select gc.goal_id,'code',v.ref,v.summary,0.95
from public.caye_goal_capabilities gc
join (values
 ('memory_context','components/dashboard/founder-home/MemoryPage.tsx','Founder memory surface exists.'),
 ('reasoning_simulation','components/dashboard/caye-direct/EngineeringAnalysisResult.tsx','Engineering analysis result surface exists.'),
 ('tool_action_execution','lib/caye-agent/tools/high-risk-gate.ts','High-risk action gating exists in the tool execution architecture.'),
 ('communication_coordination','components/dashboard/command-conversations/CommandConversations.tsx','Cross-channel conversation UI exists.'),
 ('engineering_build','components/dashboard/caye-direct/EngineeringProjectResult.tsx','Engineering project execution results are represented in Caye.'),
 ('planning_decomposition','lib/goals/types.ts','Durable goal hierarchy primitives exist.'),
 ('verification_quality','public.engineering_project_execution_evidence','Engineering execution evidence substrate exists.')
) as v(capability_key,ref,summary) on v.capability_key=gc.capability_key
on conflict do nothing;
