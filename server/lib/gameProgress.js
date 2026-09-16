const pool = require('../db/pool');

// Shared by server/routes/game.js (kid-facing progress) and
// server/lib/skillContentAuto.js (deciding what stage to generate content
// for) - one child can unlock stage N+1 in a skill once they've completed
// stage N in that same skill. Uncapped - difficulty scales relative to the
// child's own prior performance (see server/lib/llm.js) rather than
// against a fixed stage table, so there's no maximum to clamp against.
async function getAvailableStage(childId, skillSlug) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(stage), 0) AS highest_completed
     FROM game_stage_attempts
     WHERE child_id = $1 AND game_mode = $2 AND completed_at IS NOT NULL`,
    [childId, skillSlug]
  );
  return Number(result.rows[0].highest_completed) + 1;
}

module.exports = { getAvailableStage };
