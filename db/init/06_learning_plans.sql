-- A parent-requested, AI-generated personalization profile for a child.
-- The LLM never generates actual math questions/answers (that stays
-- deterministic in the existing client-side generators) - it only outputs
-- a small set of constrained tuning knobs that bias those generators, plus
-- a plain-language summary for the parent. Kept as an append-only history;
-- the most recent row per child is the "active" plan (no separate pointer
-- column to keep in sync).
CREATE TABLE learning_plans (
  id                    BIGSERIAL PRIMARY KEY,
  child_id              BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  grade                 VARCHAR(20) NOT NULL,
  parent_notes          TEXT NOT NULL,
  document_filename     TEXT,
  document_excerpt      TEXT,
  profile               JSONB NOT NULL,
  created_by_parent_id  BIGINT REFERENCES parents(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_learning_plans_child_id ON learning_plans(child_id);
