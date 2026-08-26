-- 2026-08-26 — Goal/objective substrate, part 1: schema only, no data.
--
-- WHY
-- Caye today reasons about "what needs attention right now" (owner-attention,
-- opportunity-scan) with no durable representation of WHY any of it matters
-- beyond the current turn. This adds the smallest structural chain that lets
-- Caye (and the founder) trace work back to an authorized objective:
--   VISION -> DOMAIN -> OBJECTIVE -> GOAL -> INITIATIVE
-- as one self-referential table (caye_goals, discriminated by `kind`) rather
-- than five separate tables — same "one table + a discriminator column"
-- shape business_facts already uses for its category enum, and it avoids a
-- graph database for what is, structurally, just an adjacency list plus a
-- handful of non-tree dependency edges.
--
-- WHAT THIS IS NOT
-- Not memory. business_facts/standing_rules answer "what does Caye know
-- about this business right now"; this answers "what is Caye trying to
-- accomplish and why" — status, priority, prerequisites, activation, and
-- supersession are semantics memory doesn't need and shouldn't grow.
--
-- Not the Work/Outcome runtime (CAY-8, Linear — "Design Caye's first-class
-- Work + Outcome runtime model", explicitly Backlog and read-only pending
-- its own design review). This migration stops at `initiative` as a durable
-- record of coordinated work — it does not model tasks, actions, evidence
-- links to individual tool calls, or an execution state machine. caye_goal_
-- metrics gives goals an evidence trail (progress observations), which is a
-- different, narrower thing than CAY-8's action/outcome loop.
--
-- Not autonomy. Nothing here grants Caye permission to do anything; the
-- existing authority/confirmation architecture (lib/caye-agent/tools/
-- high-risk-gate.ts) is completely untouched. A goal explains why an action
-- would be proposed; it never substitutes for the gate.
--
-- SCOPE / TENANCY
-- caye_goals.scope is 'workspace' (workspace_id set, isolated exactly like
-- every other workspace table) or 'operator' (workspace_id null — the
-- founder's own cross-business direction, e.g. the top-level Vision and the
-- Business/Personal/Research domains). There is no existing global/
-- cross-workspace table to reuse (operator_allowlist's `founder` role is
-- itself per-workspace, auto-inserted per customer) — this is a new,
-- deliberate boundary. Enforcement is entirely application-layer: RLS is
-- enabled with NO policies (same deny-by-default-to-anon/authenticated,
-- service-role-only convention as business_facts/operator_learning_audit/
-- service_date_overrides/...); every read path filters by workspace_id in
-- code, and operator-scope (workspace_id is null) rows are never returned
-- to any per-workspace agent tool call regardless of caller role — only the
-- founder-gated dashboard API can read them. See lib/goals/goals.ts.
--
-- SUPERSESSION
-- superseded_at/superseded_by mirror business_facts' pattern (never a hard
-- delete — history stays queryable). Unlike business_facts, goals don't have
-- a free-text-restatement problem that needs a canonical-key chain or an
-- atomic RPC to serialize concurrent writers on — goal mutation is a
-- deliberate founder/owner administrative act (one dashboard request at a
-- time, not concurrent WhatsApp webhook deliveries), so a same-transaction
-- application-level update is sufficient.
--
-- Reversible: drop the three tables below (dependencies and metrics first).

create table if not exists public.caye_goals (
  id                     uuid primary key default gen_random_uuid(),

  kind                   text not null check (kind in ('vision', 'domain', 'objective', 'goal', 'initiative')),
  parent_id              uuid references public.caye_goals (id) on delete set null,

  scope                  text not null check (scope in ('operator', 'workspace')),
  workspace_id           uuid references public.customers (id) on delete cascade,
  constraint caye_goals_scope_workspace_pairing check (
    (scope = 'workspace' and workspace_id is not null) or
    (scope = 'operator' and workspace_id is null)
  ),

  title                  text not null,
  description            text,

  status                 text not null default 'future'
                           check (status in ('active', 'future', 'blocked', 'paused', 'completed', 'abandoned')),
  priority               text not null default 'medium'
                           check (priority in ('low', 'medium', 'high', 'critical')),

  -- Measurable target, when the goal has one. Not forced — a goal like
  -- "Validate autonomous business operation" has completion_criteria prose
  -- instead of a number.
  target_value           numeric,
  current_value          numeric,
  unit                   text,
  target_date            date,
  -- Operator/founder-stated confidence in the target/date being right, 0-1.
  -- Never written by an LLM inference alone — see lib/goals/goals.ts.
  confidence             numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  completion_criteria    text,

  -- Structured but advisory-only. Nothing in this codebase evaluates this
  -- and flips status automatically (spec requirement: eligibility is
  -- surfaced, not auto-applied). Shape: array of
  -- {metric_key, comparator, threshold, sustained_days?}. See
  -- lib/goals/eligibility.ts.
  activation_conditions  jsonb,

  -- Provenance — who/what created this and why, so "why is Caye working on
  -- this" always has a real answer.
  created_by_kind        text not null
                           check (created_by_kind in ('founder', 'owner', 'operator', 'system', 'caye_proposed')),
  created_by_label       text,
  created_by_user_id     uuid,
  created_by_operator_id bigint references public.operator_allowlist (id) on delete set null,
  source                 text,
  rationale              text,

  superseded_at          timestamptz,
  superseded_by          uuid references public.caye_goals (id) on delete set null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.caye_goals is
  'Durable goal/objective substrate — VISION/DOMAIN/OBJECTIVE/GOAL/INITIATIVE as one self-referential table discriminated by kind. Not memory (see business_facts/standing_rules) and not the Work/Outcome execution runtime (CAY-8, reserved). Goals explain why an action would be proposed; they never grant authority to perform one.';
comment on column public.caye_goals.scope is
  'operator = founder cross-workspace direction (workspace_id null). workspace = isolated to one customer, exactly like every other workspace table.';
comment on column public.caye_goals.activation_conditions is
  'Advisory only. Read by lib/goals/eligibility.ts to compute a surfaced "eligible for activation" badge; nothing auto-applies it.';

create index if not exists caye_goals_workspace_idx
  on public.caye_goals (workspace_id, status)
  where superseded_at is null;

create index if not exists caye_goals_operator_scope_idx
  on public.caye_goals (scope, status)
  where superseded_at is null and scope = 'operator';

create index if not exists caye_goals_parent_idx
  on public.caye_goals (parent_id)
  where superseded_at is null;

create index if not exists caye_goals_kind_idx
  on public.caye_goals (kind);

alter table public.caye_goals enable row level security;

-- ── Dependencies / prerequisites ────────────────────────────────────────────
-- Separate from parent_id: a goal's prerequisite is not always its
-- structural parent (e.g. "Robotics research" is a child of the Research
-- domain but depends on the Business domain's MRR goal being satisfied).

create table if not exists public.caye_goal_dependencies (
  id                bigint generated always as identity primary key,
  goal_id           uuid not null references public.caye_goals (id) on delete cascade,
  depends_on_goal_id uuid not null references public.caye_goals (id) on delete cascade,
  created_at        timestamptz not null default now(),
  constraint caye_goal_dependencies_not_self check (goal_id <> depends_on_goal_id),
  constraint caye_goal_dependencies_unique unique (goal_id, depends_on_goal_id)
);

comment on table public.caye_goal_dependencies is
  'Prerequisite edges between goals, independent of the parent_id hierarchy. A goal with any unsatisfied dependency is not actionable — see lib/goals/goals.ts isActionable().';

create index if not exists caye_goal_dependencies_goal_idx
  on public.caye_goal_dependencies (goal_id);
create index if not exists caye_goal_dependencies_depends_on_idx
  on public.caye_goal_dependencies (depends_on_goal_id);

alter table public.caye_goal_dependencies enable row level security;

-- ── Metrics / evidence ───────────────────────────────────────────────────--
-- Progress observations. evidence_kind defaults 'authoritative' — nothing
-- in the write path lets an LLM free-write a metric without explicitly
-- marking it 'estimated', and progress displays should prefer authoritative
-- rows (see lib/goals/goals.ts, dashboard DirectionPage).

create table if not exists public.caye_goal_metrics (
  id            bigint generated always as identity primary key,
  goal_id       uuid not null references public.caye_goals (id) on delete cascade,

  metric_key    text not null,
  value         numeric not null,
  unit          text,

  evidence_kind text not null default 'authoritative' check (evidence_kind in ('authoritative', 'estimated')),
  source        text not null,
  -- Free-text pointer to whatever produced this observation (e.g.
  -- 'stripe:subscription:sub_123', 'cron:opportunity-scan'). Deliberately
  -- not an FK — the systems that will eventually produce these (billing,
  -- the future Work/Outcome runtime) aren't being coupled to this schema.
  evidence_ref  text,
  recorded_by   text,
  note          text,

  observed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table public.caye_goal_metrics is
  'Evidence used to determine real progress toward a goal. Prefer authoritative sources — evidence_kind=estimated exists so an LLM-derived observation is honestly labeled, never silently treated as fact.';

create index if not exists caye_goal_metrics_goal_idx
  on public.caye_goal_metrics (goal_id, observed_at desc);

alter table public.caye_goal_metrics enable row level security;
