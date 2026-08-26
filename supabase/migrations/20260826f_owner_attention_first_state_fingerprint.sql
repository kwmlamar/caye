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
  'state_fingerprint as it was the FIRST time this subject was ever observed. Set ONLY at insert — observeAttentionItem''s update path never writes this column, under any condition, ever, including for a row where it is currently NULL. Comparing to the live state_fingerprint tells the participation-evidence check whether the current state is the subject''s original one (a small pre-state evidence window is legitimate) or a later transition (evidence must be at-or-after the transition itself). NULL permanently means "we have no provable original state for this row" and must always resolve to the strict post-transition evidence mode — never lazily upgraded to a guessed baseline.';

-- No backfill UPDATE here, and NO lazy backfill in application code either
-- (PR #135 review, third finding — an earlier version of this design did
-- lazily backfill on next observation, which is unsafe and was removed).
-- For a row that already existed before this migration, we genuinely don't
-- know whether its CURRENT state_fingerprint is still its original one or
-- already a transition. There is no later moment — not this migration, not
-- a subsequent observeAttentionItem call, not a second or third
-- observation — where that unknown history becomes known. Any code path
-- that writes first_state_fingerprint for such a row, using either the
-- fingerprint AS OF that later write or the fingerprint the row happened
-- to have just before it, would silently convert "we don't know if this is
-- the original state" into "this is provably the original state" — which
-- is precisely the false-initial-mode bug this column exists to prevent
-- (a genuine transition would then wrongly qualify for the pre-state
-- evidence buffer). A legacy row's first_state_fingerprint stays NULL,
-- and therefore its evidence mode stays strict post-transition, for the
-- entire remaining lifetime of that row.
