-- Replaces the fixed 3-mode taxonomy (round/addsub/reading) with an
-- open-ended, AI-decided skill set per child - see the plan doc from this
-- change for full rationale. Additive/non-destructive: no data is dropped,
-- only widened constraints and metadata-only renames.

-- Canonical registry of skill identities per child, decoupled from
-- learning_plans.profile JSONB so attempts/content can reference something
-- stable and slug reuse across plan edits is a real uniqueness constraint,
-- not re-parsed JSON on every request. Never deleted - `active` reflects
-- whether the CURRENT plan still includes this skill; history stays.
CREATE TABLE child_skills (
  id                         BIGSERIAL PRIMARY KEY,
  child_id                   BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  slug                       VARCHAR(32) NOT NULL,
  title                      VARCHAR(60) NOT NULL,
  description                VARCHAR(240) NOT NULL,
  icon                       VARCHAR(8) NOT NULL,
  active                     BOOLEAN NOT NULL DEFAULT true,
  recommended_starting_stage SMALLINT NOT NULL DEFAULT 1 CHECK (recommended_starting_stage >= 1),
  source_learning_plan_id    BIGINT REFERENCES learning_plans(id) ON DELETE SET NULL,
  first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (child_id, slug),
  CHECK (slug ~ '^[a-z][a-z0-9-]{1,31}$')
);
CREATE INDEX idx_child_skills_child_active ON child_skills(child_id) WHERE active;

-- game_mode was a 3-value enum; it's now an open, AI-chosen slug. Loosen
-- the CHECK to a format constraint only - old rows with game_mode IN
-- ('round','addsub','reading') already satisfy this regex and remain
-- valid, inert history (see plan doc - no backfill into child_skills).
ALTER TABLE game_stage_attempts DROP CONSTRAINT game_stage_attempts_game_mode_check;
ALTER TABLE game_stage_attempts ADD CONSTRAINT game_stage_attempts_game_mode_check
  CHECK (game_mode ~ '^[a-z][a-z0-9-]{1,31}$');
ALTER TABLE game_stage_attempts ALTER COLUMN game_mode TYPE VARCHAR(32);

-- Stages are no longer capped at 3 - difficulty now scales relative to a
-- child's own prior performance (see server/lib/llm.js) rather than
-- against a fixed 3-tier table.
ALTER TABLE game_stage_attempts DROP CONSTRAINT game_stage_attempts_stage_check;
ALTER TABLE game_stage_attempts ADD CONSTRAINT game_stage_attempts_stage_check
  CHECK (stage >= 1);

-- reading_passages generalizes into skill-agnostic AI-generated stage
-- content for ANY skill (math skills now also need pre-generated, cached,
-- replayable content). Renamed rather than left as "reading_passages"
-- because that name would be actively misleading once non-reading skills
-- use the same table; the rename is metadata-only (instant, no data
-- rewrite) so there's no migration-time cost to justify keeping the name.
ALTER TABLE reading_passages RENAME TO skill_stage_content;
ALTER TABLE skill_stage_content ADD COLUMN skill_slug VARCHAR(32);
UPDATE skill_stage_content SET skill_slug = 'reading'; -- all existing rows ARE reading content
ALTER TABLE skill_stage_content ALTER COLUMN skill_slug SET NOT NULL;
ALTER TABLE skill_stage_content ADD CONSTRAINT skill_stage_content_slug_check
  CHECK (skill_slug ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE skill_stage_content DROP CONSTRAINT reading_passages_stage_check;
ALTER TABLE skill_stage_content ADD CONSTRAINT skill_stage_content_stage_check
  CHECK (stage >= 1);

-- passage_text is now optional (null for non-reading skills - see the
-- unified content schema in llm.js) and renamed since it's no longer
-- reading-specific.
ALTER TABLE skill_stage_content ALTER COLUMN passage_text DROP NOT NULL;
ALTER TABLE skill_stage_content RENAME COLUMN passage_text TO shared_context;

DROP INDEX idx_reading_passages_child_stage;
CREATE INDEX idx_skill_stage_content_child_skill_stage
  ON skill_stage_content(child_id, skill_slug, stage);

-- game_stage_attempts.reading_passage_id -> content_id (generalized name;
-- also a metadata-only rename - the FK target follows the table rename
-- automatically in Postgres).
ALTER TABLE game_stage_attempts RENAME COLUMN reading_passage_id TO content_id;
