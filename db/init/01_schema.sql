-- Number Quest schema. Runs once, automatically, against a fresh Postgres
-- data volume via docker-entrypoint-initdb.d. See README.md for how to
-- apply changes to an already-initialized volume.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE families (
  id            BIGSERIAL PRIMARY KEY,
  family_code   VARCHAR(8) NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE parents (
  id              BIGSERIAL PRIMARY KEY,
  family_id       BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_parents_family_id ON parents(family_id);

CREATE TABLE children (
  id             BIGSERIAL PRIMARY KEY,
  family_id      BIGINT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  display_name   VARCHAR(40) NOT NULL,
  avatar_emoji   VARCHAR(8) NOT NULL,
  pin_hash       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_children_family_id ON children(family_id);

CREATE TABLE game_stage_attempts (
  id                 BIGSERIAL PRIMARY KEY,
  child_id           BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  game_mode          VARCHAR(10) NOT NULL CHECK (game_mode IN ('round','addsub')),
  stage              SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 3),
  correct_count      INT NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  incorrect_count    INT NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
  accuracy           NUMERIC(5,4) GENERATED ALWAYS AS (
                        CASE WHEN (correct_count + incorrect_count) = 0 THEN NULL
                             ELSE ROUND(correct_count::NUMERIC / (correct_count + incorrect_count), 4)
                        END
                      ) STORED,
  passed_threshold   BOOLEAN,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX idx_attempts_child_id ON game_stage_attempts(child_id);
CREATE INDEX idx_attempts_child_open ON game_stage_attempts(child_id) WHERE completed_at IS NULL;

CREATE TABLE reward_ledger (
  id                     BIGSERIAL PRIMARY KEY,
  child_id               BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  minutes                INT NOT NULL DEFAULT 5 CHECK (minutes > 0),
  source_attempt_id      BIGINT REFERENCES game_stage_attempts(id) ON DELETE SET NULL,
  reason                 TEXT NOT NULL DEFAULT 'stage_pass',
  redeemed               BOOLEAN NOT NULL DEFAULT false,
  redeemed_at            TIMESTAMPTZ,
  redeemed_by_parent_id  BIGINT REFERENCES parents(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_child_unredeemed ON reward_ledger(child_id) WHERE redeemed = false;

-- Race-proof enforcement of "max 2 parents per family" at the DB layer.
-- The app also pre-checks before inserting so it can show a friendly error,
-- but this trigger is the actual guarantee.
CREATE OR REPLACE FUNCTION enforce_parent_cap() RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM parents WHERE family_id = NEW.family_id) >= 2 THEN
    RAISE EXCEPTION 'family % already has 2 parent accounts', NEW.family_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_parent_cap
  BEFORE INSERT ON parents
  FOR EACH ROW EXECUTE FUNCTION enforce_parent_cap();
