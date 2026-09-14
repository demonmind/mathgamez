const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const {
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidPin,
  isValidPassword,
} = require('../lib/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

router.use(requireAdmin);

router.get('/families', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT f.id, f.family_code, f.created_at,
             COUNT(DISTINCT p.id)::int AS parent_count,
             COUNT(DISTINCT c.id)::int AS child_count
      FROM families f
      LEFT JOIN parents p ON p.family_id = f.id
      LEFT JOIN children c ON c.family_id = f.id
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    res.json({ families: result.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/families/:id', async (req, res, next) => {
  try {
    const familyId = Number(req.params.id);
    if (!Number.isInteger(familyId)) {
      return res.status(400).json({ error: 'Invalid family id' });
    }

    const familyResult = await pool.query(
      'SELECT id, family_code, created_at FROM families WHERE id = $1',
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
      `SELECT c.id, c.display_name, c.avatar_emoji, c.created_at,
              COALESCE(SUM(rl.minutes) FILTER (WHERE rl.redeemed = false), 0)::int AS unredeemed_minutes
       FROM children c
       LEFT JOIN reward_ledger rl ON rl.child_id = c.id
       WHERE c.family_id = $1
       GROUP BY c.id
       ORDER BY c.created_at`,
      [familyId]
    );

    res.json({
      family: familyResult.rows[0],
      parents: parentsResult.rows,
      children: childrenResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Cascades to that family's parents, children, game attempts, and reward
// ledger rows (all FKs are ON DELETE CASCADE) - irreversible.
router.delete('/families/:id', async (req, res, next) => {
  try {
    const familyId = Number(req.params.id);
    if (!Number.isInteger(familyId)) {
      return res.status(400).json({ error: 'Invalid family id' });
    }
    const result = await pool.query('DELETE FROM families WHERE id = $1', [familyId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Family not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/parents/:id', async (req, res, next) => {
  try {
    const parentId = Number(req.params.id);
    if (!Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'Invalid parent id' });
    }
    const result = await pool.query('DELETE FROM parents WHERE id = $1', [parentId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Parent not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.patch('/parents/:id', async (req, res, next) => {
  try {
    const parentId = Number(req.params.id);
    if (!Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'Invalid parent id' });
    }
    const { password } = req.body || {};
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await pool.query(
      'UPDATE parents SET password_hash = $1 WHERE id = $2 RETURNING id',
      [passwordHash, parentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Parent not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/children/:id', async (req, res, next) => {
  try {
    const childId = Number(req.params.id);
    if (!Number.isInteger(childId)) {
      return res.status(400).json({ error: 'Invalid child id' });
    }
    const result = await pool.query('DELETE FROM children WHERE id = $1', [childId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.patch('/children/:id', async (req, res, next) => {
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

    values.push(childId);
    const result = await pool.query(
      `UPDATE children SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
