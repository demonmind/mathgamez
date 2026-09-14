-- Parent-curated YouTube videos a family's kids are allowed to redeem
-- treasure minutes to watch in-app. Deliberately allowlist-only (no open
-- search) - the app embeds via youtube-nocookie.com with no related-video
-- suggestions, so a child only ever sees videos a parent specifically added.
CREATE TABLE allowed_videos (
  id                  BIGSERIAL PRIMARY KEY,
  family_id           BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  youtube_video_id    VARCHAR(20) NOT NULL,
  title               VARCHAR(200) NOT NULL,
  added_by_parent_id  BIGINT REFERENCES parents(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_allowed_videos_family_id ON allowed_videos(family_id);

-- Tracks whether a reward was redeemed by the parent manually (real-life
-- screen time) or self-serve by the child watching an approved video
-- in-app. Exactly one of redeemed_by_parent_id / redeemed_by_child_id is
-- set on a redeemed row (enforced in application code, not a DB constraint,
-- to keep this migration additive/non-breaking).
ALTER TABLE reward_ledger ADD COLUMN redeemed_by_child_id BIGINT REFERENCES children(id) ON DELETE SET NULL;

-- Which approved video a self-serve redemption paid for, so parents can see
-- what was actually watched in the reward history, not just that it was
-- self-redeemed.
ALTER TABLE reward_ledger ADD COLUMN redeemed_video_id BIGINT REFERENCES allowed_videos(id) ON DELETE SET NULL;
