const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireParent } = require('../middleware/auth');
const { parentLoginLimiter, parentSignupLimiter } = require('../middleware/rateLimiters');
const { createFamilyWithUniqueCode, isValidFamilyCodeFormat } = require('../lib/familyCode');
const { isValidEmail, isValidPassword } = require('../lib/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// Creates a new parent account. If familyCode is provided, joins that
// existing family (rejecting if it's already at the 2-parent cap or the
// code doesn't exist); otherwise creates a brand new family. Folds the
// spec's separate "join" endpoint into signup since a parent is always
// brand new to the app at this point.
router.post('/signup', parentSignupLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    let familyCode = req.body && req.body.familyCode;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    let familyId;
    if (familyCode) {
      familyCode = String(familyCode).trim().toUpperCase();
      if (!isValidFamilyCodeFormat(familyCode)) {
        return res.status(400).json({ error: 'Invalid family code format' });
      }
      const familyResult = await pool.query(
        'SELECT id FROM families WHERE family_code = $1',
        [familyCode]
      );
      if (familyResult.rows.length === 0) {
        return res.status(404).json({ error: 'No family found with that code' });
      }
      const countResult = await pool.query(
        'SELECT COUNT(*)::int AS count FROM parents WHERE family_id = $1',
        [familyResult.rows[0].id]
      );
      if (countResult.rows[0].count >= 2) {
        return res.status(409).json({ error: 'That family already has two parent accounts' });
      }
      familyId = familyResult.rows[0].id;
    } else {
      const family = await createFamilyWithUniqueCode(pool);
      familyId = family.id;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let parent;
    try {
      const insertResult = await pool.query(
        'INSERT INTO parents (family_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, family_id',
        [familyId, email, passwordHash]
      );
      parent = insertResult.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An account with that email already exists' });
      }
      if (err.code === 'check_violation' || err.code === 'P0001') {
        return res.status(409).json({ error: 'That family already has two parent accounts' });
      }
      throw err;
    }

    await regenerateSession(req);
    req.session.role = 'parent';
    req.session.parentId = parent.id;
    req.session.familyId = parent.family_id;
    req.session.cookie.maxAge = config.parentSessionMaxAgeMs;

    res.status(201).json({ parentId: parent.id, familyId: parent.family_id });
  } catch (err) {
    next(err);
  }
});

router.post('/login', parentLoginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const result = await pool.query(
      'SELECT id, family_id, password_hash FROM parents WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const parent = result.rows[0];
    const ok = await bcrypt.compare(password, parent.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await regenerateSession(req);
    req.session.role = 'parent';
    req.session.parentId = parent.id;
    req.session.familyId = parent.family_id;
    req.session.cookie.maxAge = config.parentSessionMaxAgeMs;

    res.json({ parentId: parent.id, familyId: parent.family_id });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireParent, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('nq.sid');
    res.status(204).end();
  });
});

module.exports = router;
