const express = require('express');
const pool = require('../db/pool');
const { requireChild } = require('../middleware/auth');
const { isValidSkillSlug, isValidStage } = require('../lib/validate');
const { maybeAutoRecalibrate } = require('../lib/learningPlanAuto');
const { getAvailableStage } = require('../lib/gameProgress');
const { maybeGenerateStageContentForNextStage } = require('../lib/skillContentAuto');

const router = express.Router();
const PASS_THRESHOLD = 0.90;
const REWARD_MINUTES = 5;
// Every stage's AI-generated content is exactly this many questions - see
// isValidSkillStageContent in server/lib/validate.js, which rejects any
// content that doesn't have exactly 4.
const EXPECTED_QUESTIONS = 4;

// Confirms a slug is both well-formed AND actually one of this child's
// currently-active skills - the format check alone is not a security
// boundary, since a client could POST any well-formed slug otherwise.
async function requireActiveSkill(childId, slug) {
  if (!isValidSkillSlug(slug)) return null;
  const { rows } = await pool.query(
    'SELECT slug, title, description, icon FROM child_skills WHERE child_id = $1 AND slug = $2 AND active = true',
    [childId, slug]
  );
  return rows[0] || null;
}

// Per-skill progress: which stages (up to the unlocked one) actually have
// generated content, and which are already passed - content generation is
// async for every skill now (not just reading), so a stage can be
// "unlocked" but have nothing to play yet.
router.get('/skills/:slug/progress', requireChild, async (req, res, next) => {
  try {
    const skill = await requireActiveSkill(req.session.childId, req.params.slug);
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    const availableStage = await getAvailableStage(req.session.childId, skill.slug);
    const result = await pool.query(
      `SELECT s.stage,
              EXISTS(
                SELECT 1 FROM skill_stage_content c
                WHERE c.child_id = $1 AND c.skill_slug = $2 AND c.stage = s.stage
              ) AS "hasContent",
              bool_or(a.completed_at IS NOT NULL) AS attempted,
              bool_or(a.passed_threshold = true) AS passed
       FROM generate_series(1, $3::int) AS s(stage)
       LEFT JOIN game_stage_attempts a
         ON a.child_id = $1 AND a.game_mode = $2 AND a.stage = s.stage
       GROUP BY s.stage
       ORDER BY s.stage`,
      [req.session.childId, skill.slug, availableStage]
    );

    res.json({ availableStage, stages: result.rows });
  } catch (err) {
    next(err);
  }
});

// Picks stage content for this child at the given stage - prefers one they
// haven't completed yet, falls back to any (mastery-focused replay).
// correctIndex IS included here: the app grades every skill client-side
// and only reports correct/incorrect booleans to the server (see
// public/js/game.js) - this is the established trust model, applied
// uniformly across all skills, not a stricter one for any particular mode.
router.get('/skills/:slug/content', requireChild, async (req, res, next) => {
  try {
    const skill = await requireActiveSkill(req.session.childId, req.params.slug);
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    const stage = req.query.stage;
    if (!isValidStage(stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const result = await pool.query(
      `SELECT c.id, c.title, c.shared_context, c.questions,
              EXISTS(
                SELECT 1 FROM game_stage_attempts a
                WHERE a.content_id = c.id AND a.child_id = $1 AND a.completed_at IS NOT NULL
              ) AS previously_completed
       FROM skill_stage_content c
       WHERE c.child_id = $1 AND c.skill_slug = $2 AND c.stage = $3
       ORDER BY previously_completed ASC, random()
       LIMIT 1`,
      [req.session.childId, skill.slug, stage]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "This stage isn't ready yet - try again in a moment" });
    }

    const row = result.rows[0];
    res.json({
      contentId: row.id,
      title: row.title,
      sharedContext: row.shared_context,
      questions: row.questions,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/attempts/start', requireChild, async (req, res, next) => {
  try {
    const { skillSlug, stage, contentId } = req.body || {};
    const skill = await requireActiveSkill(req.session.childId, skillSlug);
    if (!skill || !isValidStage(stage)) {
      return res.status(400).json({ error: 'Invalid skill or stage' });
    }

    const availableStage = await getAvailableStage(req.session.childId, skill.slug);
    if (Number(stage) > availableStage) {
      return res.status(400).json({ error: 'That stage is not unlocked yet' });
    }

    const parsedContentId = Number(contentId);
    if (!Number.isInteger(parsedContentId)) {
      return res.status(400).json({ error: 'Missing stage content' });
    }
    const contentResult = await pool.query(
      'SELECT id FROM skill_stage_content WHERE id = $1 AND child_id = $2 AND skill_slug = $3 AND stage = $4',
      [parsedContentId, req.session.childId, skill.slug, stage]
    );
    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Stage content not found' });
    }

    const result = await pool.query(
      `INSERT INTO game_stage_attempts (child_id, game_mode, stage, content_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.childId, skill.slug, stage, parsedContentId]
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
      `SELECT id, game_mode, stage, correct_count, incorrect_count
       FROM game_stage_attempts
       WHERE id = $1 AND child_id = $2 AND completed_at IS NULL
       FOR UPDATE`,
      [attemptId, req.session.childId]
    );

    if (attemptResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Attempt not found or already completed' });
    }

    const { game_mode: skillSlug, stage, correct_count: correctCount, incorrect_count: incorrectCount } = attemptResult.rows[0];
    const total = correctCount + incorrectCount;

    // Every stage's content is exactly EXPECTED_QUESTIONS questions (see
    // isValidSkillStageContent) - require that many recorded answers before
    // an attempt can be completed at all, so a single forged /answer call
    // can't fast-track a pass.
    if (total !== EXPECTED_QUESTIONS) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This attempt is incomplete' });
    }

    const accuracy = correctCount / total;
    const passed = accuracy >= PASS_THRESHOLD;

    await client.query(
      'UPDATE game_stage_attempts SET completed_at = now(), passed_threshold = $1 WHERE id = $2',
      [passed, attemptId]
    );

    // A reward only pays out the first time this exact (skill, stage) is
    // ever passed - replaying an already-cleared stage is still free to
    // practice, it just doesn't mint more reward minutes each time.
    let rewardEarned = false;
    if (passed) {
      const priorRewardResult = await client.query(
        `SELECT 1 FROM reward_ledger rl
         JOIN game_stage_attempts gsa ON gsa.id = rl.source_attempt_id
         WHERE gsa.child_id = $1 AND gsa.game_mode = $2 AND gsa.stage = $3 AND rl.reason = 'stage_pass'
         LIMIT 1`,
        [req.session.childId, skillSlug, stage]
      );
      rewardEarned = priorRewardResult.rows.length === 0;

      if (rewardEarned) {
        await client.query(
          `INSERT INTO reward_ledger (child_id, minutes, source_attempt_id, reason)
           VALUES ($1, $2, $3, 'stage_pass')`,
          [req.session.childId, REWARD_MINUTES, attemptId]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      accuracy,
      passedThreshold: passed,
      rewardEarned,
      minutesEarned: rewardEarned ? REWARD_MINUTES : 0,
    });

    // Fire-and-forget: never let a ~30s LLM call delay the kid's response.
    // No-ops unless this child already has a plan, opted into auto-adapt,
    // and has enough new completed attempts since the last update.
    maybeAutoRecalibrate(req.session.childId).catch(() => {});

    // Completing a stage unlocks the next one - make sure content actually
    // exists for it (no-ops if it's already there). Applies to every
    // skill now, not just reading.
    maybeGenerateStageContentForNextStage(req.session.childId, skillSlug).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Kid-facing: the child's currently-active skills, used to render tiles
// and drive stage/content requests. focusSummary is phrased as advice to
// the parent and isn't needed here; raw parent notes stay parent-only
// (server/routes/family.js).
router.get('/learning-plan', requireChild, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT slug, title, description, icon, recommended_starting_stage
       FROM child_skills WHERE child_id = $1 AND active = true
       ORDER BY first_seen_at`,
      [req.session.childId]
    );
    const skills = result.rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      icon: r.icon,
      recommendedStartingStage: r.recommended_starting_stage,
    }));
    res.json({ skills });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
