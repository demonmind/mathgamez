const express = require('express');
const pool = require('../db/pool');
const { requireParent, requireChild, requireChildOrOwningParent } = require('../middleware/auth');
const { isValidWatchMinutes, isValidYoutubeVideoId, isValidVideoTitle } = require('../lib/validate');

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
              rl.redeemed_by_child_id, gsa.game_mode, gsa.stage,
              COALESCE(av.title, rl.redeemed_search_title) AS watched_video_title,
              (rl.redeemed_search_title IS NOT NULL) AS watched_via_search
       FROM reward_ledger rl
       LEFT JOIN game_stage_attempts gsa ON gsa.id = rl.source_attempt_id
       LEFT JOIN allowed_videos av ON av.id = rl.redeemed_video_id
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

// Child self-serve redemption: spend `minutes` of the child's own balance
// to watch one approved video right now. Minutes are marked redeemed
// immediately (same "spend it, no refund" model as the parent's manual
// redeem) - the video's actual watch time isn't tracked server-side, only
// that the child chose to spend this many minutes to watch it.
router.post('/child/:id/redeem-for-watch', requireChild, async (req, res, next) => {
  const childId = Number(req.params.id);
  if (!Number.isInteger(childId) || Number(req.session.childId) !== childId) {
    return res.status(401).json({ error: 'Not authorized for this child' });
  }

  const { minutes, videoId, searchYoutubeId, searchTitle } = req.body || {};
  if (!isValidWatchMinutes(minutes)) {
    return res.status(400).json({ error: 'Minutes must be a positive multiple of 5' });
  }

  const isSearchPick = videoId === undefined;
  let parsedVideoId = null;
  if (!isSearchPick) {
    parsedVideoId = Number(videoId);
    if (!Number.isInteger(parsedVideoId)) {
      return res.status(400).json({ error: 'Invalid video id' });
    }
  } else if (!isValidYoutubeVideoId(searchYoutubeId) || !isValidVideoTitle(searchTitle)) {
    return res.status(400).json({ error: 'Invalid video' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!isSearchPick) {
      const videoResult = await client.query(
        'SELECT id FROM allowed_videos WHERE id = $1 AND family_id = $2',
        [parsedVideoId, req.session.familyId]
      );
      if (videoResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Video not found' });
      }
    } else {
      // Defense in depth: a search-based redemption is only honored if the
      // family actually has search enabled, regardless of what the client
      // claims to have searched for.
      const familyResult = await client.query(
        'SELECT (youtube_api_key IS NOT NULL) AS enabled FROM families WHERE id = $1',
        [req.session.familyId]
      );
      if (!familyResult.rows[0] || !familyResult.rows[0].enabled) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Video search is not enabled for your family' });
      }
    }

    // Lock the unredeemed rows (oldest first) so a concurrent redemption
    // can't double-spend the same balance. FOR UPDATE can't be combined
    // with an aggregate, so the balance is summed here in application code
    // instead of via SQL SUM().
    const rowsResult = await client.query(
      `SELECT id, minutes FROM reward_ledger
       WHERE child_id = $1 AND redeemed = false
       ORDER BY created_at ASC
       FOR UPDATE`,
      [childId]
    );
    const unredeemedMinutes = rowsResult.rows.reduce((sum, row) => sum + row.minutes, 0);
    if (unredeemedMinutes < minutes) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not enough unredeemed minutes' });
    }

    // Redeem the oldest unredeemed rows first, up to the requested minutes.
    const idsToRedeem = [];
    let remaining = minutes;
    for (const row of rowsResult.rows) {
      if (remaining <= 0) break;
      idsToRedeem.push(row.id);
      remaining -= row.minutes;
    }

    await client.query(
      `UPDATE reward_ledger
       SET redeemed = true, redeemed_at = now(), redeemed_by_child_id = $1,
           redeemed_video_id = $2, redeemed_search_youtube_id = $3, redeemed_search_title = $4
       WHERE id = ANY($5::bigint[])`,
      [
        childId,
        parsedVideoId,
        isSearchPick ? searchYoutubeId : null,
        isSearchPick ? searchTitle.trim() : null,
        idsToRedeem,
      ]
    );

    await client.query('COMMIT');
    res.json({ redeemedMinutes: minutes });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
