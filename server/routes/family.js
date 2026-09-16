const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireParent } = require('../middleware/auth');
const { learningPlanLimiter } = require('../middleware/rateLimiters');
const { processDocuments, isSupportedMimeType, MAX_FILES } = require('../lib/documentText');
const { generateLearningPlan } = require('../lib/llm');
const { reconcileChildSkills } = require('../lib/skillProgress');
const { maybeGenerateStageContentForNewSkills } = require('../lib/skillContentAuto');
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
  limits: { fileSize: 8 * 1024 * 1024, files: MAX_FILES },
});

function uploadDocument(req, res, next) {
  upload.array('documents', MAX_FILES)(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (max 8MB per file)'
        : err.code === 'LIMIT_FILE_COUNT'
        ? `Please upload at most ${MAX_FILES} files`
        : 'Could not process the uploaded file(s)';
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

// Runs the local LLM once to decide which open-ended skills this child
// needs practice in (see server/lib/llm.js) - no fixed taxonomy, the model
// reads the parent's notes + grade and proposes however many apply.
// Accepts up to MAX_FILES optional documents (txt/pdf/image, mixed types
// allowed) as extra context. Slow (LLM inference, no timeout - see
// server/lib/llm.js) - the frontend should show a loading state;
// learningPlanLimiter bounds how often this can be triggered.
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
    let documentImages = [];
    let documentFilename = null;

    const files = req.files || [];
    if (files.length > 0) {
      for (const file of files) {
        if (!isSupportedMimeType(file.mimetype)) {
          return res.status(400).json({ error: `Unsupported file type (${file.originalname}) - please upload .txt, .pdf, or image (jpg/png/webp) files` });
        }
        if (file.mimetype.startsWith('image/') && !config.llmVisionCapable) {
          return res.status(400).json({ error: 'The current AI model can\'t read images - please upload .txt/.pdf files instead, or paste the details into the notes field' });
        }
      }
      documentFilename = files.map((f) => f.originalname).join(', ');
      const processed = await processDocuments(files);
      documentExcerpt = processed.excerpt;
      documentImages = processed.images;
    }

    const { rows: currentSkills } = await pool.query(
      'SELECT slug, title, description FROM child_skills WHERE child_id = $1 AND active = true',
      [childId]
    );

    const profile = await generateLearningPlan({ grade, notes, documentExcerpt, documentImages, currentSkills });

    const result = await pool.query(
      `INSERT INTO learning_plans
         (child_id, grade, parent_notes, document_filename, document_excerpt, profile, created_by_parent_id, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'parent')
       RETURNING id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at`,
      [childId, grade, notes.trim(), documentFilename, documentExcerpt, JSON.stringify(profile), req.session.parentId]
    );
    const planRow = result.rows[0];

    // Fast (no LLM call) - awaited so the parent's immediate follow-up
    // fetch of the skill list already reflects the new tiles.
    await reconcileChildSkills(childId, planRow.id, profile.skills);

    res.status(201).json(planRow);

    // Fire-and-forget: each skill's two-pass (generate + verify) content
    // call can take well over a minute and must never delay the parent's
    // response.
    maybeGenerateStageContentForNewSkills(childId, planRow).catch(() => {});
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
    let documentImages = [];
    let documentFilename = planResult.rows[0].document_filename;

    const files = req.files || [];
    if (files.length > 0) {
      for (const file of files) {
        if (!isSupportedMimeType(file.mimetype)) {
          return res.status(400).json({ error: `Unsupported file type (${file.originalname}) - please upload .txt, .pdf, or image (jpg/png/webp) files` });
        }
        if (file.mimetype.startsWith('image/') && !config.llmVisionCapable) {
          return res.status(400).json({ error: 'The current AI model can\'t read images - please upload .txt/.pdf files instead, or paste the details into the notes field' });
        }
      }
      documentFilename = files.map((f) => f.originalname).join(', ');
      const processed = await processDocuments(files);
      documentExcerpt = processed.excerpt;
      documentImages = processed.images;
    }

    const { rows: currentSkills } = await pool.query(
      'SELECT slug, title, description FROM child_skills WHERE child_id = $1 AND active = true',
      [childId]
    );

    const profile = await generateLearningPlan({ grade, notes, documentExcerpt, documentImages, currentSkills });

    const result = await pool.query(
      `UPDATE learning_plans
         SET grade = $1, parent_notes = $2, document_filename = $3, document_excerpt = $4,
             profile = $5, generated_by = 'parent', trigger_summary = NULL, created_at = NOW()
       WHERE id = $6
       RETURNING id, grade, parent_notes, document_filename, profile, generated_by, trigger_summary, created_at`,
      [grade, notes.trim(), documentFilename, documentExcerpt, JSON.stringify(profile), planId]
    );
    const planRow = result.rows[0];

    await reconcileChildSkills(childId, planRow.id, profile.skills);

    res.json(planRow);

    // Fire-and-forget, same as the initial-generation path - only
    // generates content for skills that don't have any yet at their
    // available stage (e.g. a newly-added skill).
    maybeGenerateStageContentForNewSkills(childId, planRow).catch(() => {});
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
