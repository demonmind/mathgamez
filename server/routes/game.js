const express = require('express');
const pool = require('../db/pool');
const { requireChild } = require('../middleware/auth');
const { isValidGameMode, isValidStage } = require('../lib/validate');
const { maybeAutoRecalibrate } = require('../lib/learningPlanAuto');
const { getAvailableStage } = require('../lib/gameProgress');
const { maybeGenerateReadingPassageForNextStage } = require('../lib/readingPassageAuto');

const router = express.Router();
const PASS_THRESHOLD = 0.85;
const REWARD_MINUTES = 5;

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

// Reading-only: which stages (up to the unlocked one) actually have at
// least one generated passage, since unlike math there's no infinite
// procedural supply - a stage can be "unlocked" but have nothing to play
// yet if the AI hasn't generated anything for it.
router.get('/reading/stages', requireChild, async (req, res, next) => {
  try {
    const availableStage = await getAvailableStage(req.session.childId, 'reading');
    const result = await pool.query(
      `SELECT stage, COUNT(*)::int AS passage_count
       FROM reading_passages
       WHERE child_id = $1 AND stage <= $2
       GROUP BY stage
       ORDER BY stage`,
      [req.session.childId, availableStage]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    next(err);
  }
});

// Picks a passage for this child at the given stage - prefers one they
// haven't completed yet, falls back to any (mastery-focused replay, same
// spirit as math stages). correctIndex IS included here: the app already
// grades rounding/add-sub answers client-side and only reports
// correct/incorrect booleans to the server (see public/js/game.js), so
// reading follows the same established trust model rather than a stricter
// one applied only to this mode.
router.get('/reading/passage', requireChild, async (req, res, next) => {
  try {
    const stage = req.query.stage;
    if (!isValidStage(stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const result = await pool.query(
      `SELECT rp.id, rp.title, rp.passage_text, rp.questions,
              EXISTS(
                SELECT 1 FROM game_stage_attempts gsa
                WHERE gsa.reading_passage_id = rp.id AND gsa.child_id = $1 AND gsa.completed_at IS NOT NULL
              ) AS previously_completed
       FROM reading_passages rp
       WHERE rp.child_id = $1 AND rp.stage = $2
       ORDER BY previously_completed ASC, random()
       LIMIT 1`,
      [req.session.childId, stage]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No stories available for this stage yet' });
    }

    const row = result.rows[0];
    res.json({
      passageId: row.id,
      title: row.title,
      passageText: row.passage_text,
      questions: row.questions,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/attempts/start', requireChild, async (req, res, next) => {
  try {
    const { gameMode, stage, readingPassageId } = req.body || {};
    if (!isValidGameMode(gameMode) || !isValidStage(stage)) {
      return res.status(400).json({ error: 'Invalid game mode or stage' });
    }

    const availableStage = await getAvailableStage(req.session.childId, gameMode);
    if (Number(stage) > availableStage) {
      return res.status(400).json({ error: 'That stage is not unlocked yet' });
    }

    let passageId = null;
    if (gameMode === 'reading') {
      passageId = Number(readingPassageId);
      if (!Number.isInteger(passageId)) {
        return res.status(400).json({ error: 'Missing reading passage' });
      }
      const passageResult = await pool.query(
        'SELECT id FROM reading_passages WHERE id = $1 AND child_id = $2 AND stage = $3',
        [passageId, req.session.childId, stage]
      );
      if (passageResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reading passage not found' });
      }
    }

    const result = await pool.query(
      `INSERT INTO game_stage_attempts (child_id, game_mode, stage, reading_passage_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.childId, gameMode, stage, passageId]
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
      `SELECT id, game_mode, correct_count, incorrect_count
       FROM game_stage_attempts
       WHERE id = $1 AND child_id = $2 AND completed_at IS NULL
       FOR UPDATE`,
      [attemptId, req.session.childId]
    );

    if (attemptResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Attempt not found or already completed' });
    }

    const { game_mode: gameMode, correct_count: correctCount, incorrect_count: incorrectCount } = attemptResult.rows[0];
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

    // Fire-and-forget: never let a ~30s LLM call delay the kid's response.
    // No-ops unless this child already has a plan, opted into auto-adapt,
    // and has enough new completed attempts since the last update.
    maybeAutoRecalibrate(req.session.childId).catch(() => {});

    // Reading completion unlocks the next stage - make sure a passage
    // actually exists for it (no-ops if one's already there or reading
    // practice isn't enabled for this child).
    if (gameMode === 'reading') {
      maybeGenerateReadingPassageForNextStage(req.session.childId).catch(() => {});
    }
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Kid-facing: only the tuning knobs the game generators actually use.
// focusSummary is phrased as advice to the parent and isn't needed here;
// the parent's raw notes/document stay parent-only (server/routes/family.js).
router.get('/learning-plan', requireChild, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT profile FROM learning_plans WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.session.childId]
    );
    const profile = result.rows[0] ? result.rows[0].profile : null;
    const tunables = profile && {
      recommendedMode: profile.recommendedMode,
      recommendedStartingStage: profile.recommendedStartingStage,
      subtractionEmphasis: profile.subtractionEmphasis,
      extraWordProblems: profile.extraWordProblems,
      numberRangeAdjustment: profile.numberRangeAdjustment,
      includeReadingPractice: profile.includeReadingPractice,
    };
    res.json({ profile: tunables });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
