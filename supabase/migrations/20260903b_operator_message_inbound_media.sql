-- 2026-09-03 — remember which media an inbound message carried
--
-- Caye already downloads inbound WhatsApp images and hands the bytes to the
-- model, but persists only a text placeholder ('[image]') on the message row.
-- The bytes are never stored and the media id is never kept, so the image is
-- readable on exactly one turn and unreachable afterwards. handleImageInbound
-- says as much in its own comment: "the model only ever receives image bytes
-- on the turn they arrive... a silently-collected image is never seen."
--
-- That is fine for "look at this photo" and fatal for anything staged. A
-- receipt is recorded through the confirmation path — Caye proposes what she
-- read, a human confirms, and the write happens on a LATER turn, by which
-- point the bytes are long gone.
--
-- Keeping the media id (not the bytes) is what makes the confirm-then-write
-- shape possible, and keeps the more important property: nothing is uploaded
-- or written into the construction ledger until a human has actually
-- approved it. Meta serves the media for ~30 days, which is far longer than
-- any confirmation should take; if it has expired, the write fails honestly
-- instead of recording a receipt with no image behind it.
--
-- Its own column rather than reusing rich_result, which belongs to a
-- different concern. Nullable: every message that is not media has none.
alter table public.caye_operator_messages
  add column if not exists inbound_media jsonb;

comment on column public.caye_operator_messages.inbound_media is
  'For inbound media messages: {media_id, mime_type} as WhatsApp reported them. The id is a handle for re-fetching bytes from Meta on a later turn, not the bytes themselves. Null for text messages.';
