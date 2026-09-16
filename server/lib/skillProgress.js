const pool = require('../db/pool');

// Upserts every skill from a freshly-generated plan into child_skills, and
// deactivates any previously-active skill not present in the new list.
// Exact-slug-match only (no fuzzy title matching) - silently merging two
// skills the model actually intended to be different is worse than
// occasionally losing continuity on one it renamed. Never deletes rows:
// game_stage_attempts.game_mode and skill_stage_content.skill_slug keep
// pointing at the same slug regardless of `active`, so a deactivated
// skill's history isn't destroyed - it just stops rendering as a tile,
// and reintroducing the same slug later picks the history back up.
async function reconcileChildSkills(childId, planId, skills) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const keepSlugs = skills.map((s) => s.slug);

    for (const skill of skills) {
      await client.query(
        `INSERT INTO child_skills (child_id, slug, title, description, icon, active, recommended_starting_stage, source_learning_plan_id)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)
         ON CONFLICT (child_id, slug) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           active = true,
           recommended_starting_stage = EXCLUDED.recommended_starting_stage,
           source_learning_plan_id = EXCLUDED.source_learning_plan_id,
           updated_at = now()`,
        [childId, skill.slug, skill.title, skill.description, skill.icon, skill.recommendedStartingStage, planId]
      );
    }

    if (keepSlugs.length > 0) {
      await client.query(
        `UPDATE child_skills SET active = false, updated_at = now()
         WHERE child_id = $1 AND active = true AND slug <> ALL($2::varchar[])`,
        [childId, keepSlugs]
      );
    } else {
      await client.query(
        `UPDATE child_skills SET active = false, updated_at = now() WHERE child_id = $1 AND active = true`,
        [childId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Reuses the existing game_stage_attempts.accuracy generated column (see
// db/init/01_schema.sql) - no new tracking needed. Feeds the last 10
// completed attempts for this (child, skill) into stage-content
// generation so difficulty can adapt per stage transition, not just via
// the separate every-N-completions plan recalibration job.
async function buildSkillPerformanceSummary(childId, skillSlug) {
  const { rows } = await pool.query(
    `SELECT stage, accuracy, passed_threshold
     FROM game_stage_attempts
     WHERE child_id = $1 AND game_mode = $2 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 10`,
    [childId, skillSlug]
  );
  if (rows.length === 0) return null;
  return rows.reverse().map((r) =>
    `Stage ${r.stage}: ${Math.round(Number(r.accuracy) * 100)}% (${r.passed_threshold ? 'passed' : 'did not pass'})`
  ).join('\n');
}

module.exports = { reconcileChildSkills, buildSkillPerformanceSummary };
