const pool = require('../db/pool');
const config = require('../config/env');
const { generateLearningPlan } = require('./llm');
const { reconcileChildSkills } = require('./skillProgress');
const { maybeGenerateStageContentForNewSkills } = require('./skillContentAuto');

// Prevents two completions landing close together from triggering two
// concurrent LLM calls for the same child.
const inProgress = new Set();

async function buildPerformanceSummary(childId, attempts) {
  const slugs = Array.from(new Set(attempts.map((a) => a.game_mode)));
  const { rows: skillRows } = await pool.query(
    'SELECT slug, title FROM child_skills WHERE child_id = $1 AND slug = ANY($2::varchar[])',
    [childId, slugs]
  );
  const labels = new Map(skillRows.map((s) => [s.slug, s.title]));

  const groups = new Map();
  for (const a of attempts) {
    const key = `${a.game_mode}:${a.stage}`;
    if (!groups.has(key)) groups.set(key, { mode: a.game_mode, stage: a.stage, accuracies: [] });
    groups.get(key).accuracies.push(Number(a.accuracy));
  }
  return Array.from(groups.values()).map((g) => {
    const avg = g.accuracies.reduce((sum, a) => sum + a, 0) / g.accuracies.length;
    const label = labels.get(g.mode) || g.mode;
    const pcts = g.accuracies.map((a) => `${Math.round(a * 100)}%`).join(', ');
    return `- ${label}, Stage ${g.stage}: ${g.accuracies.length} attempt(s), accuracy ${pcts} (average ${Math.round(avg * 100)}%)`;
  }).join('\n');
}

// Fire-and-forget from the attempt-completion route. Only ever adjusts an
// EXISTING plan (never creates a first plan without a parent having opted
// in), only after enough new completed attempts have accumulated since the
// last update, and only if the parent hasn't turned it off for this child.
// Never awaited by the caller - a kid should never wait on a ~30s LLM call
// just to see their stage-complete screen. Now only adjusts the skill list
// itself and each skill's recommended starting stage - per-stage content
// difficulty adapts independently, on every stage transition, via
// server/lib/skillContentAuto.js's own performance summary.
async function maybeAutoRecalibrate(childId) {
  if (inProgress.has(childId)) return;

  try {
    const childResult = await pool.query(
      'SELECT auto_adapt_enabled FROM children WHERE id = $1',
      [childId]
    );
    if (!childResult.rows[0] || !childResult.rows[0].auto_adapt_enabled) return;

    const planResult = await pool.query(
      `SELECT grade, parent_notes, created_at FROM learning_plans
       WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [childId]
    );
    const latestPlan = planResult.rows[0];
    if (!latestPlan) return;

    const attemptsResult = await pool.query(
      `SELECT game_mode, stage, accuracy
       FROM game_stage_attempts
       WHERE child_id = $1 AND completed_at IS NOT NULL AND completed_at > $2
       ORDER BY completed_at ASC`,
      [childId, latestPlan.created_at]
    );
    if (attemptsResult.rows.length < config.autoRecalThreshold) return;

    inProgress.add(childId);

    const summary = await buildPerformanceSummary(childId, attemptsResult.rows);
    const notes = [
      `Previous notes from the parent: ${latestPlan.parent_notes}`,
      '',
      'Recent practice performance since the last plan update:',
      summary,
      '',
      'Update the skill list based on this performance. If a skill is being passed easily, you can raise its recommendedStartingStage or drop it if it seems mastered. If they are still struggling in an area, keep it (or add related skills).',
    ].join('\n');

    const { rows: currentSkills } = await pool.query(
      'SELECT slug, title, description FROM child_skills WHERE child_id = $1 AND active = true',
      [childId]
    );

    const profile = await generateLearningPlan({ grade: latestPlan.grade, notes, currentSkills });

    const insertResult = await pool.query(
      `INSERT INTO learning_plans (child_id, grade, parent_notes, profile, generated_by, trigger_summary)
       VALUES ($1, $2, $3, $4, 'auto', $5)
       RETURNING id, grade, parent_notes`,
      [childId, latestPlan.grade, latestPlan.parent_notes, JSON.stringify(profile), summary]
    );
    console.log(`Auto-recalibrated learning plan for child ${childId}`);

    const planRow = insertResult.rows[0];
    await reconcileChildSkills(childId, planRow.id, profile.skills);
    maybeGenerateStageContentForNewSkills(childId, planRow).catch(() => {});
  } catch (err) {
    console.error(`Auto-recalibration failed for child ${childId}:`, err.message);
  } finally {
    inProgress.delete(childId);
  }
}

module.exports = { maybeAutoRecalibrate };
