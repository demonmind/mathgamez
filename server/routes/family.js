const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { requireParent } = require('../middleware/auth');
const {
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidPin,
  isValidApiKey,
  AVATAR_EMOJI_ALLOWLIST,
} = require('../lib/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

router.get('/me', requireParent, async (req, res, next) => {
  try {
    const familyId = req.session.familyId;

    const familyResult = await pool.query(
      `SELECT id, family_code, created_at, (youtube_api_key IS NOT NULL) AS video_search_enabled
       FROM families WHERE id = $1`,
      [familyId]
    );
    if (familyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Family not found' });
    }

    const parentsResult = await pool.query(
      'SELECT id, email, created_at FROM parents WHERE family_id = $1 ORDER BY created_at',
      [familyId]
    );
    const childrenResult = await pool.query(
      'SELECT id, display_name, avatar_emoji, created_at FROM children WHERE family_id = $1 ORDER BY created_at',
      [familyId]
    );

    res.json({
      family: familyResult.rows[0],
      parents: parentsResult.rows,
      children: childrenResult.rows,
      avatarChoices: AVATAR_EMOJI_ALLOWLIST,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/children', requireParent, async (req, res, next) => {
  try {
    const { displayName, avatarEmoji, pin } = req.body || {};

    if (!isValidDisplayName(displayName)) {
      return res.status(400).json({ error: 'Please enter a name (1-40 characters)' });
    }
    if (!isValidAvatarEmoji(avatarEmoji)) {
      return res.status(400).json({ error: 'Please choose a valid avatar' });
    }
    if (!isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO children (family_id, display_name, avatar_emoji, pin_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, avatar_emoji, created_at`,
      [req.session.familyId, displayName.trim(), avatarEmoji, pinHash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/children/:id', requireParent, async (req, res, next) => {
  try {
    const childId = Number(req.params.id);
    if (!Number.isInteger(childId)) {
      return res.status(400).json({ error: 'Invalid child id' });
    }

    const { displayName, avatarEmoji, pin } = req.body || {};
    const updates = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) {
      if (!isValidDisplayName(displayName)) {
        return res.status(400).json({ error: 'Please enter a name (1-40 characters)' });
      }
      updates.push(`display_name = $${idx++}`);
      values.push(displayName.trim());
    }
    if (avatarEmoji !== undefined) {
      if (!isValidAvatarEmoji(avatarEmoji)) {
        return res.status(400).json({ error: 'Please choose a valid avatar' });
      }
      updates.push(`avatar_emoji = $${idx++}`);
      values.push(avatarEmoji);
    }
    if (pin !== undefined) {
      if (!isValidPin(pin)) {
        return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
      }
      const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
      updates.push(`pin_hash = $${idx++}`);
      values.push(pinHash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    values.push(childId, req.session.familyId);
    const result = await pool.query(
      `UPDATE children SET ${updates.join(', ')}
       WHERE id = $${idx++} AND family_id = $${idx}
       RETURNING id, display_name, avatar_emoji, created_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Sets or clears the family's YouTube API key - presence of a key IS the
// "video search enabled" flag. The key is write-only from the client's
// perspective: it's never sent back in any GET response.
router.patch('/settings', requireParent, async (req, res, next) => {
  try {
    const { youtubeApiKey } = req.body || {};

    if (youtubeApiKey === null || youtubeApiKey === '') {
      await pool.query('UPDATE families SET youtube_api_key = NULL WHERE id = $1', [req.session.familyId]);
      return res.json({ videoSearchEnabled: false });
    }

    if (!isValidApiKey(youtubeApiKey)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid API key' });
    }

    await pool.query('UPDATE families SET youtube_api_key = $1 WHERE id = $2', [youtubeApiKey.trim(), req.session.familyId]);
    res.json({ videoSearchEnabled: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
