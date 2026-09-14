const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireChild } = require('../middleware/auth');
const { childPinLimiter, childPinIpLimiter } = require('../middleware/rateLimiters');
const { isValidPin } = require('../lib/validate');

const router = express.Router();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

router.post('/login', childPinIpLimiter, childPinLimiter, async (req, res, next) => {
  try {
    const childId = Number(req.body && req.body.childId);
    const pin = req.body && req.body.pin;

    if (!Number.isInteger(childId) || !isValidPin(pin)) {
      return res.status(400).json({ error: 'Invalid PIN' });
    }

    const result = await pool.query(
      'SELECT id, family_id, pin_hash FROM children WHERE id = $1',
      [childId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    const child = result.rows[0];
    const ok = await bcrypt.compare(pin, child.pin_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    await regenerateSession(req);
    req.session.role = 'child';
    req.session.childId = child.id;
    req.session.familyId = child.family_id;
    req.session.cookie.maxAge = config.childSessionMaxAgeMs;

    res.json({ childId: child.id });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireChild, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('nq.sid');
    res.status(204).end();
  });
});

router.get('/session', requireChild, async (req, res, next) => {
  try {
    const familyResult = await pool.query(
      'SELECT (youtube_api_key IS NOT NULL) AS video_search_enabled FROM families WHERE id = $1',
      [req.session.familyId]
    );
    res.json({
      childId: req.session.childId,
      videoSearchEnabled: familyResult.rows[0] ? familyResult.rows[0].video_search_enabled : false,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
