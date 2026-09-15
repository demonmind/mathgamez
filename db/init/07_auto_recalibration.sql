-- Distinguishes a parent-initiated plan from one the background
-- recalibration job produced, and (for auto rows) keeps the performance
-- summary that was fed to the LLM, so a parent can see why it changed.
ALTER TABLE learning_plans ADD COLUMN generated_by VARCHAR(10) NOT NULL DEFAULT 'parent'
  CHECK (generated_by IN ('parent', 'auto'));
ALTER TABLE learning_plans ADD COLUMN trigger_summary TEXT;

-- Per-child opt-out for the background recalibration - a parent who wants
-- fully manual control over the plan can turn this off. Defaults on since
-- it only ever runs for a child who already has a parent-created plan.
ALTER TABLE children ADD COLUMN auto_adapt_enabled BOOLEAN NOT NULL DEFAULT true;
