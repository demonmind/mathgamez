const pool = require('../db/pool');
const { generateReadingPassage } = require('./llm');
const { getAvailableStage } = require('./gameProgress');

// Prevents overlapping generations for the same child.
const inProgress = new Set();

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
    const passage = await generateReadingPassage({ grade: plan.grade, stage, notes: plan.parent_notes });

    await pool.query(
      `INSERT INTO reading_passages (child_id, stage, title, passage_text, questions, source_learning_plan_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [childId, stage, passage.title, passage.passageText, JSON.stringify(passage.questions), plan.id || null]
    );
    console.log(`Generated reading passage for child ${childId} at stage ${stage}`);
  } catch (err) {
    console.error(`Reading passage generation failed for child ${childId}:`, err.message);
  } finally {
    inProgress.delete(childId);
  }
}

module.exports = { maybeGenerateReadingPassage };
