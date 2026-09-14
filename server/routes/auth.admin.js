const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireAdmin } = require('../middleware/auth');
const { adminLoginLimiter } = require('../middleware/rateLimiters');
const { isValidEmail } = require('../lib/validate');

const router = express.Router();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

router.post('/login', adminLoginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const result = await pool.query(
      'SELECT id, password_hash FROM admins WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const admin = result.rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await regenerateSession(req);
    req.session.role = 'admin';
    req.session.adminId = admin.id;
    req.session.cookie.maxAge = config.adminSessionMaxAgeMs;

    res.json({ adminId: admin.id });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAdmin, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('nq.sid');
    res.status(204).end();
  });
});

module.exports = router;
