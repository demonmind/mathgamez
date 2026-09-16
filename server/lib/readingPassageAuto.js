const pool = require('../db/pool');
const { generateReadingPassage } = require('./llm');
const { getAvailableStage } = require('./gameProgress');

// Prevents overlapping generations for the same child.
const inProgress = new Set();

async function generateAndStorePassage(childId, plan, stage) {
  const passage = await generateReadingPassage({ grade: plan.grade, stage, notes: plan.parent_notes });

  await pool.query(
    `INSERT INTO reading_passages (child_id, stage, title, passage_text, questions, source_learning_plan_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [childId, stage, passage.title, passage.passageText, JSON.stringify(passage.questions), plan.id || null]
  );
  console.log(`Generated reading passage for child ${childId} at stage ${stage}`);
}

// Called (fire-and-forget) after any learning_plans row is inserted -
// parent-initiated or the background auto-recalibration - whenever the
// plan's profile flags that reading practice would help. Writes exactly
// one new passage at whatever reading stage the child currently has
// unlocked. Never awaited by callers; a ~30s+ two-pass LLM call must never
// block a parent's or the auto-recal job's response.
async function maybeGenerateReadingPassage(childId, plan) {
  if (!plan || !plan.profile || !plan.profile.includeReadingPractice) return;
  if (inProgress.has(childId)) return;

  inProgress.add(childId);
  try {
    const stage = await getAvailableStage(childId, 'reading');
    await generateAndStorePassage(childId, plan, stage);
  } catch (err) {
    console.error(`Reading passage generation failed for child ${childId}:`, err.message);
  } finally {
    inProgress.delete(childId);
  }
}

// Called (fire-and-forget) whenever a child completes a reading-mode stage
// attempt - completing a stage is what unlocks the next one (see
// getAvailableStage), but nothing else writes a passage for that newly
// unlocked stage. Without this, a child could clear stage 1 and simply
// have nothing to play at stage 2 until the next periodic
// auto-recalibration cycle (which can be many stages away) happened to
// write one - the stage picker would just keep offering stage 1 again.
//
// Deliberately does NOT require the latest plan's includeReadingPractice
// flag once the child already has a passage from an earlier stage: that
// flag only decides whether reading practice gets switched on in the first
// place. A later plan edit that refocuses on a math struggle (and doesn't
// mention reading) replaces the whole profile - see the "replace, not
// merge" behavior in server/routes/family.js - but shouldn't retroactively
// cut off a child who is already partway through Story Cove.
async function maybeGenerateReadingPassageForNextStage(childId) {
  if (inProgress.has(childId)) return;

  const stage = await getAvailableStage(childId, 'reading');
  const existing = await pool.query(
    'SELECT 1 FROM reading_passages WHERE child_id = $1 AND stage = $2 LIMIT 1',
    [childId, stage]
  );
  if (existing.rows.length > 0) return;

  const planResult = await pool.query(
    `SELECT id, grade, parent_notes, profile FROM learning_plans
     WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [childId]
  );
  if (planResult.rows.length === 0) return;
  const plan = planResult.rows[0];

  if (!plan.profile || !plan.profile.includeReadingPractice) {
    const hasReadBefore = await pool.query(
      'SELECT 1 FROM reading_passages WHERE child_id = $1 LIMIT 1',
      [childId]
    );
    if (hasReadBefore.rows.length === 0) return;
  }

  inProgress.add(childId);
  try {
    await generateAndStorePassage(childId, plan, stage);
  } catch (err) {
    console.error(`Reading passage generation failed for child ${childId}:`, err.message);
  } finally {
    inProgress.delete(childId);
  }
}

module.exports = { maybeGenerateReadingPassage, maybeGenerateReadingPassageForNextStage };
