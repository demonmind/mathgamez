const express = require('express');
const pool = require('../db/pool');
const { requireParent, requireChildOrOwningParent } = require('../middleware/auth');

const router = express.Router();

router.get('/child/:id', requireChildOrOwningParent, async (req, res, next) => {
  try {
    const childId = Number(req.params.id);

    const balanceResult = await pool.query(
      `SELECT COALESCE(SUM(minutes), 0)::int AS unredeemed_minutes
       FROM reward_ledger WHERE child_id = $1 AND redeemed = false`,
      [childId]
    );

    const historyResult = await pool.query(
      `SELECT rl.id, rl.minutes, rl.reason, rl.redeemed, rl.redeemed_at, rl.created_at,
              gsa.game_mode, gsa.stage
       FROM reward_ledger rl
       LEFT JOIN game_stage_attempts gsa ON gsa.id = rl.source_attempt_id
       WHERE rl.child_id = $1
       ORDER BY rl.created_at DESC
       LIMIT 100`,
      [childId]
    );

    res.json({
      unredeemedMinutes: balanceResult.rows[0].unredeemed_minutes,
      history: historyResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Marks every currently-unredeemed ledger row for this child as redeemed in
// one shot - this is how the parent manually confirms they gave the actual
// screen time in real life. Family-scoped so a parent can't redeem another
// family's child.
router.post('/child/:id/redeem', requireParent, async (req, res, next) => {
  try {
    const childId = Number(req.params.id);
    if (!Number.isInteger(childId)) {
      return res.status(400).json({ error: 'Invalid child id' });
    }

    const childResult = await pool.query(
      'SELECT id FROM children WHERE id = $1 AND family_id = $2',
      [childId, req.session.familyId]
    );
    if (childResult.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const result = await pool.query(
      `UPDATE reward_ledger
       SET redeemed = true, redeemed_at = now(), redeemed_by_parent_id = $1
       WHERE child_id = $2 AND redeemed = false
       RETURNING minutes`,
      [req.session.parentId, childId]
    );

    const totalMinutes = result.rows.reduce((sum, row) => sum + row.minutes, 0);
    res.json({ redeemedCount: result.rows.length, totalMinutes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
