const express = require('express');
const pool = require('../db/pool');
const { requireChild } = require('../middleware/auth');
const { isValidGameMode, isValidStage } = require('../lib/validate');

const router = express.Router();
const MAX_STAGE = 3;
const PASS_THRESHOLD = 0.85;
const REWARD_MINUTES = 5;

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

router.get('/progress', requireChild, async (req, res, next) => {
  try {
    const gameMode = req.query.mode;
    if (!isValidGameMode(gameMode)) {
      return res.status(400).json({ error: 'Invalid game mode' });
    }
    const availableStage = await getAvailableStage(req.session.childId, gameMode);
    res.json({ availableStage });
  } catch (err) {
    next(err);
  }
});

router.post('/attempts/start', requireChild, async (req, res, next) => {
  try {
    const { gameMode, stage } = req.body || {};
    if (!isValidGameMode(gameMode) || !isValidStage(stage)) {
      return res.status(400).json({ error: 'Invalid game mode or stage' });
    }

    const availableStage = await getAvailableStage(req.session.childId, gameMode);
    if (Number(stage) > availableStage) {
      return res.status(400).json({ error: 'That stage is not unlocked yet' });
    }

    const result = await pool.query(
      `INSERT INTO game_stage_attempts (child_id, game_mode, stage)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.session.childId, gameMode, stage]
    );

    res.status(201).json({ attemptId: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

router.post('/attempts/:id/answer', requireChild, async (req, res, next) => {
  try {
    const attemptId = Number(req.params.id);
    const correct = req.body && req.body.correct;
    if (!Number.isInteger(attemptId) || typeof correct !== 'boolean') {
      return res.status(400).json({ error: 'Invalid answer report' });
    }

    const column = correct ? 'correct_count' : 'incorrect_count';
    const result = await pool.query(
      `UPDATE game_stage_attempts SET ${column} = ${column} + 1
       WHERE id = $1 AND child_id = $2 AND completed_at IS NULL
       RETURNING id`,
      [attemptId, req.session.childId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attempt not found or already completed' });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/attempts/:id/complete', requireChild, async (req, res, next) => {
  const attemptId = Number(req.params.id);
  if (!Number.isInteger(attemptId)) {
    return res.status(400).json({ error: 'Invalid attempt id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const attemptResult = await client.query(
      `SELECT id, correct_count, incorrect_count
       FROM game_stage_attempts
       WHERE id = $1 AND child_id = $2 AND completed_at IS NULL
       FOR UPDATE`,
      [attemptId, req.session.childId]
    );

    if (attemptResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Attempt not found or already completed' });
    }

    const { correct_count: correctCount, incorrect_count: incorrectCount } = attemptResult.rows[0];
    const total = correctCount + incorrectCount;
    const accuracy = total > 0 ? correctCount / total : 0;
    const passed = total > 0 && accuracy >= PASS_THRESHOLD;

    await client.query(
      'UPDATE game_stage_attempts SET completed_at = now(), passed_threshold = $1 WHERE id = $2',
      [passed, attemptId]
    );

    if (passed) {
      await client.query(
        `INSERT INTO reward_ledger (child_id, minutes, source_attempt_id, reason)
         VALUES ($1, $2, $3, 'stage_pass')`,
        [req.session.childId, REWARD_MINUTES, attemptId]
      );
    }

    await client.query('COMMIT');

    res.json({
      accuracy,
      passedThreshold: passed,
      rewardEarned: passed,
      minutesEarned: passed ? REWARD_MINUTES : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
