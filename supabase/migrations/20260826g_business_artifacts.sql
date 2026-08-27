-- 2026-08-26 — Multimodal Business Memory (#87)
--
-- Today an inbound WhatsApp image is downloaded to a base64 string, handed to
-- one Claude vision turn as `content`, and then discarded — only a text
-- placeholder ("[image]") survives into `caye_operator_messages`. Ask Caye
-- about that photo in a fresh conversation and there is nothing left to find.
-- Email/Gmail attachments are never even read (extractBody() walks the MIME
-- tree and silently skips any part with a filename/attachmentId).
--
-- This migration adds the durable evidence layer. Three tables, cleanly
-- separated per the issue's core architecture:
--   business_artifacts            — immutable-ish original bytes + provenance
--   business_artifact_observations — derived understanding, supersedable
--   business_artifact_relations    — links to the business graph, supersedable
--
-- Do NOT make object storage the brain: the bucket only ever holds bytes.
-- Everything Caye reasons over — what it shows, what it's linked to, who
-- confirmed that — lives in these three tables.
--
-- Conventions followed (see 20260811b_caye_pending_operations.sql,
-- 20260826c_operator_learning_audit.sql, 20260625_business_facts.sql):
--   * workspace_id references customers(id) — the workspace IS the customer row.
--   * RLS enabled, zero policies — deny-by-default, service-role-only, same as
--     every other caye_*/business_* table. Nothing in the customer dashboard
--     reads these.
--   * Supersession via superseded_by/superseded_at (never mutate/delete a
--     derived row), mirroring business_facts.
--   * Open-ended vocabularies (source_channel, observation_type's 'other'
--     escape hatch, relation_type) stay free text — the caye_pending_operations
--     lesson: a new channel or relation kind must never wait on a migration.
--     Closed-world states (origin, modality, processing_status, provenance)
--     are check-constrained.
--
-- Async processing reuses caye_pending_operations (operation='artifact_process')
-- rather than a second queue — see lib/pending-operations.ts.

create table if not exists business_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,

  -- Where this artifact came from, per the issue's generation-ready schema.
  -- 'external' = arrived from a customer/third party over a connected channel.
  -- 'operator_uploaded' / 'customer_uploaded' = a human attached it directly
  -- (dashboard upload, future). 'caye_generated' = produced by a Caye tool/
  -- provider (no generation provider ships in this PR, but the column exists
  -- so a future flyer/image-gen artifact fits without a schema change).
  -- 'derived' = a representation of another artifact (thumbnail, transcript).
  origin text not null default 'external'
    check (origin in ('external', 'operator_uploaded', 'customer_uploaded', 'caye_generated', 'derived')),

  -- Free text on purpose (caye_pending_operations lesson): 'whatsapp_operator',
  -- 'whatsapp_frontdesk', 'email_zoho', 'email_gmail', 'instagram', 'messenger',
  -- 'dashboard' today; a new channel must never wait on a migration to land.
  source_channel text not null,

  -- Provenance back to the conversation/message this artifact arrived on.
  -- Nullable and plural because the channels that produce artifacts write to
  -- different tables (front-desk/email → unified_messages, back-office
  -- WhatsApp → caye_operator_messages) — see the audit in the PR description
  -- for why a single polymorphic FK isn't a cleaner fit than two nullable ones.
  conversation_id uuid references public.unified_conversations(id) on delete set null,
  unified_message_id uuid references public.unified_messages(id) on delete set null,
  operator_message_id uuid references public.caye_operator_messages(id) on delete set null,

  -- Who supplied it, when known. A customer contact and an operator are
  -- mutually exclusive in practice but not enforced as such here — ingestion
  -- code sets exactly one based on source_channel.
  sender_contact_id uuid references public.contacts(id) on delete set null,
  sender_operator_allowlist_id uuid references public.operator_allowlist(id) on delete set null,
  -- Display fallback when neither FK resolves (e.g. a name Caye was told but
  -- couldn't match to a contact row yet).
  sender_label text,

  -- The provider's own id for this attachment (WhatsApp media id, Gmail
  -- attachmentId, Zoho attachment id) — the idempotency anchor for retries.
  provider_attachment_id text,

  filename text,
  declared_mime_type text,
  -- What the bytes actually are, sniffed server-side. Never trust the
  -- extension or the provider-declared mime type for authorization/rendering.
  detected_mime_type text,
  byte_size bigint,
  -- sha256 of the raw bytes. Used for duplicate detection, not as a unique
  -- key — two genuinely different sends can legitimately share bytes (the
  -- same flyer forwarded by two people), so this is a lookup aid, not a
  -- constraint. provider_attachment_id is the idempotency guarantee.
  content_sha256 text not null,

  modality text not null
    check (modality in ('image', 'document', 'audio', 'video', 'spreadsheet', 'other')),

  storage_bucket text not null default 'business-artifacts',
  -- {workspace_id}/{artifact_id}/original.<ext> — never derived from the
  -- provider filename, so a hostile/weird filename can't become a path.
  storage_path text not null,

  received_at timestamptz not null default now(),

  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'completed', 'failed', 'unsupported')),
  -- Bumped when the understanding pipeline for a modality changes shape, so a
  -- reprocess can be targeted ("reprocess everything below version 2")
  -- without re-ingesting bytes.
  processing_version int not null default 1,
  processing_error text,
  processing_completed_at timestamptz,

  -- Explicit retention/deletion state (issue #9). 'active' = normal.
  -- 'tombstoned' = hidden from ordinary retrieval but bytes + rows retained
  -- (e.g. source message deleted upstream, workspace policy keeps evidence).
  -- 'deleted' = bytes actually removed from storage; the row and its
  -- observations/relations remain as a tombstone record of what existed.
  retention_status text not null default 'active'
    check (retention_status in ('active', 'tombstoned', 'deleted')),
  tombstoned_at timestamptz,
  tombstoned_reason text,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table business_artifacts is
  'Canonical workspace-scoped evidence record for an ingested/generated file (image/document/audio/video). Immutable-ish: bytes never change after ingestion. Service-role only — see 20260826g header for the RLS convention this follows.';
comment on column business_artifacts.provider_attachment_id is
  'Idempotency anchor. A webhook retry or reconnect replay for the same provider attachment must resolve to the SAME row, never a second one — see the unique index below.';
comment on column business_artifacts.detected_mime_type is
  'Sniffed from actual bytes, not the extension or provider-declared mime type. The issue is explicit: never trust a filename extension.';
comment on column business_artifacts.retention_status is
  'active = normal. tombstoned = hidden from retrieval, bytes retained. deleted = bytes actually removed from storage; row/observations/relations remain as history.';

-- Idempotent retry key: the same provider attachment delivered twice (webhook
-- retry, duplicate message ingestion, reconnect replay) resolves to one row.
create unique index if not exists business_artifacts_provider_attachment_idx
  on business_artifacts (workspace_id, source_channel, provider_attachment_id)
  where provider_attachment_id is not null;

-- Dedup lookup aid, not a uniqueness constraint (see column comment above).
create index if not exists business_artifacts_content_hash_idx
  on business_artifacts (workspace_id, content_sha256);

create index if not exists business_artifacts_conversation_idx
  on business_artifacts (workspace_id, conversation_id) where conversation_id is not null;

create index if not exists business_artifacts_received_idx
  on business_artifacts (workspace_id, received_at desc);

-- "The image Mrs. Max just sent" — most recent artifact from a specific
-- operator, the deterministic resolution path for a same-thread follow-up
-- correction that never needs session/active-work state to answer.
create index if not exists business_artifacts_sender_operator_idx
  on business_artifacts (workspace_id, sender_operator_allowlist_id, received_at desc)
  where sender_operator_allowlist_id is not null;

create index if not exists business_artifacts_processing_pending_idx
  on business_artifacts (processing_status) where processing_status = 'pending';

alter table business_artifacts enable row level security;

-- Deriveed understanding. Never mutated after write — a correction inserts a
-- new row and supersedes the old one, exactly like business_facts.
create table if not exists business_artifact_observations (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references business_artifacts(id) on delete cascade,
  -- Denormalized from the artifact for direct workspace-scoped queries
  -- without a join, matching the rest of the schema's convention.
  workspace_id uuid not null references public.customers(id) on delete cascade,

  observation_type text not null check (observation_type in (
    'visual_description', 'visible_text', 'document_extraction', 'summary',
    'entity_observation', 'operator_annotation', 'transcript',
    'spreadsheet_schema', 'other'
  )),
  modality text,

  -- Shape varies by observation_type — e.g. {"description": "..."} for
  -- visual_description, {"pages": [{"page": 1, "text": "..."}], "full_text":
  -- "..."} for document_extraction. Treated as untrusted quoted evidence
  -- wherever it's surfaced to a model — see lib/artifacts/prompt-format.ts.
  content jsonb not null default '{}'::jsonb,

  -- Model confidence where applicable (0-1). Distinct from provenance_status:
  -- a human-confirmed observation has no numeric confidence at all.
  confidence numeric,

  -- The issue's provenance categories. 'extracted' = mechanically pulled from
  -- the artifact (OCR-free text extraction, transcript). 'observed' = a
  -- direct visual/audio observation. 'inferred' = a guess beyond what's
  -- directly visible (e.g. "this looks like X tour's pickup point").
  -- 'operator_confirmed' = a human said so. 'superseded' = corrected; the row
  -- stays for history via superseded_by/superseded_at below.
  provenance_status text not null default 'extracted'
    check (provenance_status in ('extracted', 'observed', 'inferred', 'operator_confirmed', 'superseded')),

  -- 'model:claude-sonnet-4-6' | 'operator:<operator_allowlist_id>' | 'system:reprocess'.
  derived_by text not null,
  model_version text,

  superseded_by uuid references business_artifact_observations(id),
  superseded_at timestamptz,

  created_at timestamptz not null default now()
);

comment on table business_artifact_observations is
  'Derived understanding of an artifact — NOT automatically business truth. Supersedable: a correction inserts a new row and marks the old one superseded_by/superseded_at, mirroring business_facts. Service-role only.';
comment on column business_artifact_observations.content is
  'Untrusted quoted evidence, even when it is extracted document text. Never render this to a model as an instruction — see lib/artifacts/prompt-format.ts.';

create index if not exists business_artifact_observations_artifact_idx
  on business_artifact_observations (artifact_id, observation_type, created_at desc);

create index if not exists business_artifact_observations_active_idx
  on business_artifact_observations (artifact_id, observation_type)
  where superseded_at is null;

create index if not exists business_artifact_observations_workspace_idx
  on business_artifact_observations (workspace_id);

alter table business_artifact_observations enable row level security;

-- The relationship layer. Polymorphic target (no cross-table FK is possible
-- across contacts/bookings/services/business_facts/etc — same shape as the
-- existing caye_direct_thread_entities polymorphic-pointer pattern).
create table if not exists business_artifact_relations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  artifact_id uuid not null references business_artifacts(id) on delete cascade,

  -- Free text (caye_pending_operations lesson) — the relation vocabulary will
  -- grow (depicts_location, relates_to_contact, relates_to_booking,
  -- relates_to_project, supporting_evidence_for_fact, sent_by, derived_from,
  -- generated_from, thumbnail_of, transcript_of, ...) and a new kind must
  -- never wait on a migration.
  relation_type text not null,
  -- 'contact' | 'operator' | 'booking' | 'service' | 'business_fact' |
  -- 'artifact' | 'conversation' | 'vendor' | 'expense' | 'project' | ...
  target_entity_type text not null,
  target_entity_id uuid not null,

  -- Short human-readable label for display ("pickup location for cruise
  -- guests") — NOT the authoritative meaning. The authoritative meaning
  -- traces through source_observation_id to an operator_annotation
  -- observation with full provenance.
  label text,

  status text not null default 'candidate'
    check (status in ('candidate', 'confirmed', 'corrected', 'rejected')),
  confidence numeric,
  provenance text not null default 'model_inferred'
    check (provenance in ('model_inferred', 'operator_confirmed', 'operator_corrected', 'system_derived')),

  source_observation_id uuid references business_artifact_observations(id) on delete set null,
  confirmed_by_operator_allowlist_id uuid references public.operator_allowlist(id) on delete set null,
  confirmed_at timestamptz,

  -- Supersession chain, same shape as business_artifact_observations.
  corrected_from_relation_id uuid references business_artifact_relations(id),
  superseded_at timestamptz,

  created_at timestamptz not null default now()
);

comment on table business_artifact_relations is
  'Links an artifact to the business graph (contact/booking/project/business_fact/...) with confidence, provenance, and a correction/supersession chain. Ambiguous links stay status=candidate until evidence/operator confirmation — do not require ingestion-time resolution. Service-role only.';
comment on column business_artifact_relations.target_entity_id is
  'Polymorphic — no cross-table FK constraint is possible across heterogeneous target tables. Same pattern as caye_direct_thread_entities.';

-- Only one CONFIRMED, non-superseded relation per (artifact, target) at a
-- time — a correction supersedes the prior confirmed relation rather than
-- creating a second one. Candidates are unrestricted; several guesses can
-- coexist until one is confirmed.
create unique index if not exists business_artifact_relations_confirmed_idx
  on business_artifact_relations (artifact_id, target_entity_type, target_entity_id)
  where status = 'confirmed' and superseded_at is null;

create index if not exists business_artifact_relations_artifact_idx
  on business_artifact_relations (artifact_id);

create index if not exists business_artifact_relations_target_idx
  on business_artifact_relations (workspace_id, target_entity_type, target_entity_id);

alter table business_artifact_relations enable row level security;

-- Private bucket for original artifact bytes. public=false — no public URLs,
-- ever. All access goes through createServiceClient() (bypasses storage RLS
-- the same way it bypasses table RLS), which mints short-lived signed URLs
-- server-side (lib/artifacts/storage.ts). No storage.objects policies are
-- added for anon/authenticated — same deny-by-default posture as every
-- table above; a future customer-dashboard read would need an explicit,
-- reviewed policy, not inherited access.
--
-- allowed_mime_types is intentionally broader than what this PR actually
-- processes (audio/video included) — the issue requires original bytes to
-- be preserved even for modalities whose understanding pipeline isn't built
-- yet (processing_status='unsupported'), so the bucket must accept them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'business-artifacts',
  'business-artifacts',
  false,
  104857600, -- 100MB ceiling at the bucket level; per-channel limits are tighter and enforced in lib/artifacts/ingest.ts.
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac',
    'video/mp4', 'video/quicktime', 'video/3gpp'
  ]
)
on conflict (id) do nothing;
