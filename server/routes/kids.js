const express = require('express');
const pool = require('../db/pool');
const { isValidFamilyCodeFormat } = require('../lib/familyCode');
const { familyLookupLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Public-ish: lets the kid login screen show a family's avatar grid before
// any authentication. Only ever selects id/display_name/avatar_emoji -
// pin_hash must never be reachable through this endpoint. Rate-limited
// since an unauthenticated, no-other-limiter route keyed on a guessable
// 6-character code would otherwise allow scripted enumeration of every
// family's children.
router.get('/family/:familyCode', familyLookupLimiter, async (req, res, next) => {
  try {
    const familyCode = String(req.params.familyCode || '').trim().toUpperCase();
    if (!isValidFamilyCodeFormat(familyCode)) {
      return res.status(400).json({ error: 'Invalid family code' });
    }

    const familyResult = await pool.query(
      'SELECT id FROM families WHERE family_code = $1',
      [familyCode]
    );
    if (familyResult.rows.length === 0) {
      return res.status(404).json({ error: 'No family found with that code' });
    }

    const childrenResult = await pool.query(
      'SELECT id, display_name, avatar_emoji FROM children WHERE family_id = $1 ORDER BY created_at',
      [familyResult.rows[0].id]
    );

    res.json({ children: childrenResult.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
