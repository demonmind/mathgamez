-- Opt-in, per-family YouTube search. A family only gets search if a parent
-- explicitly sets their own Google Cloud API key here - presence of a key
-- IS the "enabled" flag (no separate toggle to avoid an on-but-no-key or
-- key-but-off confusing state). Never returned to the frontend after
-- saving - write-only from the client's perspective, like a password.
ALTER TABLE families ADD COLUMN youtube_api_key TEXT;

-- Search results aren't part of a family's curated allowed_videos list (a
-- parent didn't specifically approve them), so a search-based redemption
-- snapshots the video's id/title directly on the ledger row instead of
-- going through allowed_videos.
ALTER TABLE reward_ledger ADD COLUMN redeemed_search_youtube_id VARCHAR(20);
ALTER TABLE reward_ledger ADD COLUMN redeemed_search_title VARCHAR(200);
