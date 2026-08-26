-- 2026-08-26 — caye_owner_attention.first_state_fingerprint.
--
-- WHY (PR #135 review, second finding)
-- operator_aware_fingerprint/_at (20260826e) fixed suppressing a
-- notification the operator already handled — but the participation
-- evidence window it used (up to 60 minutes BEFORE the reported state's own
-- timestamp) doesn't distinguish two different claims:
--
--   A. "the operator's action plausibly CAUSED this state to first exist"
--      (e.g. Mrs. Max quoting Autumn is what led the customer to reply and
--      the system to create the pending booking a few minutes later — a
--      small pre-state window is legitimate here)
--   B. "the operator's action predates a fact that did not exist yet"
--      (e.g. Mrs. Max handled the pending booking at 1:39; payment clears
--      at 2:05 — her 1:39 action cannot be evidence she knows about a 2:05
--      event, no matter how the lookback window is sized)
--
-- A fixed-size lookback can't tell A from B — any window generous enough to
-- cover A's real production lag also, structurally, covers B. The fix is
-- not a smaller/larger constant; it's knowing which case applies.
--
-- first_state_fingerprint answers that deterministically: stamped ONCE,
-- the moment a subject is first observed, and never touched again by any
-- later observation. Comparing it to the live state_fingerprint tells you
-- whether the CURRENT state is still the subject's original one (case A —
-- a pre-state evidence window is legitimate) or the fingerprint has since
-- moved on to a real transition (case B — evidence must be at-or-after the
-- transition, no pre-state window at all). See
-- decideOperatorNotification's participation-evidence-mode logic and
-- lib/whatsapp/operator-participation.ts's ParticipationEvidenceMode.
alter table caye_owner_attention
  add column if not exists first_state_fingerprint text;

comment on column caye_owner_attention.first_state_fingerprint is
  'state_fingerprint as it was the FIRST time this subject was ever observed. Set once at insert; also lazily backfilled by observeAttentionItem on the first post-migration update of a row that predates this column (see its own comment) — never overwritten once set. Comparing to the live state_fingerprint tells the participation-evidence check whether the current state is the subject''s original one (a small pre-state evidence window is legitimate) or a later transition (evidence must be at-or-after the transition itself).';

-- No backfill UPDATE here on purpose: for a row that already existed before
-- this migration, we genuinely don't know whether its CURRENT
-- state_fingerprint is still its original one or already a transition —
-- guessing either way risks being wrong in the unsafe direction (treating
-- a real transition as "still original" would wrongly permit a pre-state
-- evidence window for it). observeAttentionItem instead backfills lazily,
-- the first time each such row is next observed post-migration, treating
-- that moment as the baseline going forward — safe (NULL means "not
-- provably still original", the stricter mode) and self-healing without
-- a bulk guess.
