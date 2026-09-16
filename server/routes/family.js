const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireParent } = require('../middleware/auth');
const { learningPlanLimiter } = require('../middleware/rateLimiters');
const { processDocument, isSupportedMimeType } = require('../lib/documentText');
const { generateLearningPlan } = require('../lib/llm');
const { maybeGenerateReadingPassage } = require('../lib/readingPassageAuto');
const {
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidPin,
  isValidApiKey,
  isValidGrade,
  isValidLearningPlanNotes,
  AVATAR_EMOJI_ALLOWLIST,
} = require('../lib/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function uploadDocument(req, res, next) {
  upload.single('document')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (max 8MB)'
        : 'Could not process the uploaded file';
      return res.status(400).json({ error: message });
    }
    next();
  });
}

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
      'SELECT id, display_name, avatar_emoji, auto_adapt_enabled, created_at FROM children WHERE family_id = $1 ORDER BY created_at',
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

    const { displayName, avatarEmoji, pin, autoAdaptEnabled } = req.body || {};
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
    if (autoAdaptEnabled !== undefined) {
      if (typeof autoAdaptEnabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid value' });
      }
      updates.push(`auto_adapt_enabled = $${idx++}`);
      values.push(autoAdaptEnabled);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    values.push(childId, req.session.familyId);
    const result = await pool.query(
      `UPDATE children SET ${updates.join(', ')}
       WHERE id = $${idx++} AND family_id = $${idx}
       RETURNING id, display_name, avatar_emoji, auto_adapt_enabled, created_at`,
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

// Runs the local LLM once to produce a small set of tuning knobs for this
// child's question generation (never actual math questions/answers - see
// server/lib/llm.js). Accepts an optional document (txt/pdf/image) as
// extra context. Slow (LLM inference) - the frontend should show a loading
// state; learningPlanLimiter bounds how often this can be triggered.
router.post('/children/:id/learning-plan', requireParent, learningPlanLimiter, uploadDocument, async (req, res, next) => {
  try {
    const childId = Number(req.params.id);
    if (!Number.isInteger(childId)) {
      return res.status(400).json({ error: 'Invalid child id' });
    }

    const { grade, notes } = req.body || {};
    if (!isValidGrade(grade)) {
      return res.status(400).json({ error: 'Please choose a grade' });
    }
    if (!isValidLearningPlanNotes(notes)) {
      return res.status(400).json({ error: 'Please describe what your child struggles with (1-2000 characters)' });
    }

    const childResult = await pool.query(
      'SELECT id FROM children WHERE id = $1 AND family_id = $2',
      [childId, req.session.familyId]
    );
    if (childResult.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }

    let documentExcerpt = null;
    let documentImage = null;
    let documentFilename = null;

    if (req.file) {
      documentFilename = req.file.originalname;
      if (!isSupportedMimeType(req.file.mimetype)) {
        return res.status(400).json({ error: 'Unsupported file type - please upload a .txt, .pdf, or image (jpg/png/webp)' });
      }
      if (req.file.mimetype.startsWith('image/') && !config.llmVisionCapable) {
        return res.status(400).json({ error: 'The current AI model can\'t read images - please upload a .txt or .pdf instead, or paste the details into the notes field' });
      }
      const processed = await processDocument(req.file);
      documentExcerpt = processed.excerpt || null;
      documentImage = processed.image || null;
    }

    const profile = await generateLearningPlan({ grade, notes, documentExcerpt, documentImage });

    const result = await pool.query(
      `INSERT INTO learning_plans
         (child_id, grade, parent_notes, document_filename, document_excerpt, profile, created_by_parent_id, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'parent')
       RETURNING id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at`,
      [childId, grade, notes.trim(), documentFilename, documentExcerpt, JSON.stringify(profile), req.session.parentId]
    );

    res.status(201).json(result.rows[0]);

    // Fire-and-forget: a two-pass (generate + verify) passage call can take
    // well over a minute and must never delay the parent's response.
    maybeGenerateReadingPassage(childId, result.rows[0]).catch(() => {});
  } catch (err) {
    next(err);
  }
});

// Edits an earlier prompt in place and regenerates its tuning profile from
// the updated grade/notes - unlike POST above (which always adds a new
// row), this updates the same learning_plans row and bumps created_at, so
// an edited older prompt becomes the active plan again (GET /learning-plan
// and the kid-facing tunables both just take the most recent row).
router.patch('/children/:id/learning-plan/:planId', requireParent, learningPlanLimiter, uploadDocument, async (req, res, next) => {
  try {
    const childId = Number(req.params.id);
    const planId = Number(req.params.planId);
    if (!Number.isInteger(childId) || !Number.isInteger(planId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const { grade, notes } = req.body || {};
    if (!isValidGrade(grade)) {
      return res.status(400).json({ error: 'Please choose a grade' });
    }
    if (!isValidLearningPlanNotes(notes)) {
      return res.status(400).json({ error: 'Please describe what your child struggles with (1-2000 characters)' });
    }

    const childResult = await pool.query(
      'SELECT id FROM children WHERE id = $1 AND family_id = $2',
      [childId, req.session.familyId]
    );
    if (childResult.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const planResult = await pool.query(
      'SELECT id, document_filename, document_excerpt FROM learning_plans WHERE id = $1 AND child_id = $2',
      [planId, childId]
    );
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    let documentExcerpt = planResult.rows[0].document_excerpt;
    let documentImage = null;
    let documentFilename = planResult.rows[0].document_filename;

    if (req.file) {
      documentFilename = req.file.originalname;
      if (!isSupportedMimeType(req.file.mimetype)) {
        return res.status(400).json({ error: 'Unsupported file type - please upload a .txt, .pdf, or image (jpg/png/webp)' });
      }
      if (req.file.mimetype.startsWith('image/') && !config.llmVisionCapable) {
        return res.status(400).json({ error: 'The current AI model can\'t read images - please upload a .txt or .pdf instead, or paste the details into the notes field' });
      }
      const processed = await processDocument(req.file);
      documentExcerpt = processed.excerpt || null;
      documentImage = processed.image || null;
    }

    const profile = await generateLearningPlan({ grade, notes, documentExcerpt, documentImage });

    const result = await pool.query(
      `UPDATE learning_plans
         SET grade = $1, parent_notes = $2, document_filename = $3, document_excerpt = $4,
             profile = $5, generated_by = 'parent', trigger_summary = NULL, created_at = NOW()
       WHERE id = $6
       RETURNING id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at`,
      [grade, notes.trim(), documentFilename, documentExcerpt, JSON.stringify(profile), planId]
    );

    res.json(result.rows[0]);

    // Fire-and-forget, same as the initial-generation path - the profile
    // may have newly turned reading practice on/off.
    maybeGenerateReadingPassage(childId, result.rows[0]).catch(() => {});
  } catch (err) {
    next(err);
  }
});

router.get('/children/:id/learning-plan', requireParent, async (req, res, next) => {
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
      `SELECT id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at
       FROM learning_plans WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [childId]
    );
    res.json({ plan: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// Full history (not just the latest) - so generating a new plan never
// quietly makes an earlier one invisible in the dashboard.
router.get('/children/:id/learning-plans', requireParent, async (req, res, next) => {
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
      `SELECT id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at
       FROM learning_plans WHERE child_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [childId]
    );
    res.json({ plans: result.rows });
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
