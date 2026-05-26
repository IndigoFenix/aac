-- Migration 0109: unified permitted-YouTube list
--
-- Adds aac_settings.permitted_youtube_items, a single array that holds
-- channels, playlists, and pinned videos distinguished by a `type` field:
--   { "type": "channel"|"playlist"|"video", "id": "...", "label": "...", "description": "..." }
--
-- Backfilled from the two legacy arrays (permitted_youtube_channels +
-- permitted_youtube_videos), which are intentionally KEPT for rollback safety.
-- The application stops writing the legacy columns after this migration; all
-- reads go through permitted_youtube_items (with a legacy-merge fallback in
-- shared/youtube-items.ts for any row written between deploy and migrate).

ALTER TABLE "aac_settings" ADD COLUMN "permitted_youtube_items" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint

UPDATE "aac_settings" SET "permitted_youtube_items" = (
  COALESCE((
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'type', 'channel',
      'id', c->>'channelId',
      'label', c->>'label',
      'description', c->>'description'
    )))
    FROM jsonb_array_elements(COALESCE("permitted_youtube_channels", '[]'::jsonb)) AS c
    WHERE c->>'channelId' IS NOT NULL
  ), '[]'::jsonb)
  ||
  COALESCE((
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'type', 'video',
      'id', v->>'videoId',
      'label', v->>'label',
      'description', v->>'description'
    )))
    FROM jsonb_array_elements(COALESCE("permitted_youtube_videos", '[]'::jsonb)) AS v
    WHERE v->>'videoId' IS NOT NULL
  ), '[]'::jsonb)
)
WHERE jsonb_typeof("permitted_youtube_channels") = 'array'
   OR jsonb_typeof("permitted_youtube_videos") = 'array';
