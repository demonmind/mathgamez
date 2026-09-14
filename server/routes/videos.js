const express = require('express');
const pool = require('../db/pool');
const { requireParent, requireChild } = require('../middleware/auth');
const { videoSearchLimiter } = require('../middleware/rateLimiters');
const { parseYoutubeVideoId, isValidVideoTitle, isValidSearchQuery } = require('../lib/validate');
const { searchYoutubeVideos } = require('../lib/youtube');

const router = express.Router();

router.get('/', requireParent, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, youtube_video_id, title, created_at FROM allowed_videos WHERE family_id = $1 ORDER BY created_at DESC',
      [req.session.familyId]
    );
    res.json({ videos: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireParent, async (req, res, next) => {
  try {
    const { url, title } = req.body || {};
    const videoId = parseYoutubeVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: "Couldn't find a video ID in that link" });
    }
    if (!isValidVideoTitle(title)) {
      return res.status(400).json({ error: 'Please enter a title (1-200 characters)' });
    }

    const result = await pool.query(
      `INSERT INTO allowed_videos (family_id, youtube_video_id, title, added_by_parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, youtube_video_id, title, created_at`,
      [req.session.familyId, videoId, title.trim(), req.session.parentId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireParent, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (!Number.isInteger(videoId)) {
      return res.status(400).json({ error: 'Invalid video id' });
    }
    const result = await pool.query(
      'DELETE FROM allowed_videos WHERE id = $1 AND family_id = $2',
      [videoId, req.session.familyId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Read-only, family-scoped list for the kid-facing "watch a video" picker -
// never exposes added_by_parent_id or other families' videos.
router.get('/kid', requireChild, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, youtube_video_id, title FROM allowed_videos WHERE family_id = $1 ORDER BY created_at DESC',
      [req.session.familyId]
    );
    res.json({ videos: result.rows });
  } catch (err) {
    next(err);
  }
});

// Live YouTube search, gated on the family having set their own API key
// (that presence IS the opt-in). safeSearch=strict is applied server-side
// in lib/youtube.js - still a best-effort filter, not a guarantee, which
// is why this is opt-in and documented as such on the parent dashboard.
router.get('/search', requireChild, videoSearchLimiter, async (req, res, next) => {
  try {
    const query = req.query.q;
    if (!isValidSearchQuery(query)) {
      return res.status(400).json({ error: 'Please enter a search term' });
    }

    const familyResult = await pool.query(
      'SELECT youtube_api_key FROM families WHERE id = $1',
      [req.session.familyId]
    );
    const apiKey = familyResult.rows[0] && familyResult.rows[0].youtube_api_key;
    if (!apiKey) {
      return res.status(403).json({ error: 'Video search is not enabled for your family' });
    }

    const results = await searchYoutubeVideos(apiKey, query);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
