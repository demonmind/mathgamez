-- AI-generated reading comprehension content. Unlike math questions
-- (generated fresh every time from a deterministic formula), a reading
-- passage has to stay fixed while a child answers questions about it, so
-- it's generated once and stored, then reused across plays. Generation
-- uses a two-pass pattern (write, then an independent verification pass
-- checking the answer key against the passage text) - see
-- server/lib/llm.js - since there's no deterministic correctness check
-- for reading comprehension the way there is for arithmetic.
CREATE TABLE reading_passages (
  id                       BIGSERIAL PRIMARY KEY,
  child_id                 BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  stage                    SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 3),
  title                    VARCHAR(200) NOT NULL,
  passage_text             TEXT NOT NULL,
  questions                JSONB NOT NULL, -- [{question, options:[4 strings], correctIndex:0-3}, ...]
  source_learning_plan_id  BIGINT REFERENCES learning_plans(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reading_passages_child_stage ON reading_passages(child_id, stage);

-- Which passage a reading-mode attempt was about (null for math attempts).
ALTER TABLE game_stage_attempts ADD COLUMN reading_passage_id BIGINT REFERENCES reading_passages(id) ON DELETE SET NULL;

ALTER TABLE game_stage_attempts DROP CONSTRAINT game_stage_attempts_game_mode_check;
ALTER TABLE game_stage_attempts ADD CONSTRAINT game_stage_attempts_game_mode_check
  CHECK (game_mode IN ('round', 'addsub', 'reading'));
