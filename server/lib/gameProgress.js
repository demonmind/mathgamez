const pool = require('../db/pool');

const MAX_STAGE = 3;

// Shared by server/routes/game.js (kid-facing progress) and
// server/lib/readingPassageAuto.js (deciding what stage to write a new
// passage for) - one child can unlock stage N+1 in a mode once they've
// completed stage N in that same mode.
async function getAvailableStage(childId, gameMode) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(stage), 0) AS highest_completed
     FROM game_stage_attempts
     WHERE child_id = $1 AND game_mode = $2 AND completed_at IS NOT NULL`,
    [childId, gameMode]
  );
  const highestCompleted = result.rows[0].highest_completed;
  return Math.min(MAX_STAGE, highestCompleted + 1);
}

module.exports = { getAvailableStage, MAX_STAGE };
