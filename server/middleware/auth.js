const pool = require('../db/pool');

function requireParent(req, res, next) {
  if (req.session && req.session.role === 'parent') return next();
  return res.status(401).json({ error: 'Parent login required' });
}

function requireChild(req, res, next) {
  if (req.session && req.session.role === 'child') return next();
  return res.status(401).json({ error: 'Child login required' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(401).json({ error: 'Admin login required' });
}

// GET /api/rewards/child/:id is readable by the child themself, or by a
// parent in the same family as that child (re-derived from the DB, never
// trusted from the session/client alone).
async function requireChildOrOwningParent(req, res, next) {
  const childId = Number(req.params.id);
  if (!Number.isInteger(childId)) {
    return res.status(400).json({ error: 'Invalid child id' });
  }

  // req.session.childId came from a Postgres BIGSERIAL column, which the pg
  // driver returns as a string - compare numerically, not with strict ===.
  if (req.session && req.session.role === 'child' && Number(req.session.childId) === childId) {
    return next();
  }

  if (req.session && req.session.role === 'parent') {
    try {
      const result = await pool.query(
        'SELECT id FROM children WHERE id = $1 AND family_id = $2',
        [childId, req.session.familyId]
      );
      if (result.rows.length > 0) return next();
    } catch (err) {
      return next(err);
    }
  }

  return res.status(401).json({ error: 'Not authorized for this child' });
}

module.exports = { requireParent, requireChild, requireAdmin, requireChildOrOwningParent };
