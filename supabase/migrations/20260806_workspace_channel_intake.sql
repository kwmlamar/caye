-- Channel intake for the post-onboarding connect walkthrough.
--
-- Holds what the owner told Caye about their setup: which social channels
-- guests actually use, the email provider detected from their domain (MX,
-- not asked), how the guest-facing WhatsApp number is arranged, and any
-- tools they named that Caye has no connector for.
--
-- Deliberately one jsonb column rather than a table: it is a small,
-- per-workspace, read-together blob with no independent lifecycle.
--
-- Its presence is also the rollout gate. Every workspace that predates
-- this migration has channel_intake IS NULL, and the walkthrough refuses
-- to initiate without it — so existing customers (Bimini, who is fully
-- activated and has deliberately skipped WhatsApp) are grandfathered
-- silently, with no backfill and no risk of Caye messaging them about a
-- channel they already declined.
--
-- Shape:
-- {
--   "inventory":        { "instagram": true, "messenger": false, "whatsapp": true },
--   "emailProvider":    "google" | "zoho" | "microsoft" | "other" | null,
--   "whatsappLine":     "business" | "personal" | "landline" | null,
--   "unsupportedTools": ["Square", "Calendly"]
-- }

alter table workspace_ai_config
  add column if not exists channel_intake jsonb;

comment on column workspace_ai_config.channel_intake is
  'Connect-walkthrough intake (see lib/channels/slots.ts ChannelIntake). NULL = workspace predates the walkthrough; Caye must not initiate one.';
