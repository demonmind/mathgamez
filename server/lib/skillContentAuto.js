const pool = require('../db/pool');
const { generateSkillStageContent } = require('./llm');
const { getAvailableStage } = require('./gameProgress');
const { buildSkillPerformanceSummary } = require('./skillProgress');

// Prevents overlapping generations for the same (child, skill, stage) -
// keyed more narrowly than a plain childId Set, since skills now generate
// independently of each other and must not block one another.
const inProgress = new Set();

// At most this many skills generate concurrently per child when fanning
// out across a freshly-created/edited plan's skill list - a single local
// llama.cpp instance likely serializes requests anyway, so unbounded
// concurrency here would just queue up timeouts.
const FANOUT_CONCURRENCY = 2;

async function generateAndStoreStage(childId, plan, skill, stage) {
  const key = `${childId}:${skill.slug}:${stage}`;
  if (inProgress.has(key)) return;
  inProgress.add(key);
  try {
    const performanceSummary = await buildSkillPerformanceSummary(childId, skill.slug);
    const content = await generateSkillStageContent({
      grade: plan.grade,
      skill,
      stage,
      notes: plan.parent_notes,
      performanceSummary,
    });

    await pool.query(
      `INSERT INTO skill_stage_content (child_id, skill_slug, stage, title, shared_context, questions, source_learning_plan_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [childId, skill.slug, stage, content.title, content.sharedContext, JSON.stringify(content.questions), plan.id || null]
    );
    console.log(`Generated stage ${stage} content for child ${childId}, skill ${skill.slug}`);
  } catch (err) {
    console.error(`Stage content generation failed for child ${childId}, skill ${skill.slug}, stage ${stage}:`, err.message);
  } finally {
    inProgress.delete(key);
  }
}

async function hasContentAtStage(childId, skillSlug, stage) {
  const { rows } = await pool.query(
    'SELECT 1 FROM skill_stage_content WHERE child_id = $1 AND skill_slug = $2 AND stage = $3 LIMIT 1',
    [childId, skillSlug, stage]
  );
  return rows.length > 0;
}

// Called (fire-and-forget) after a plan is created or edited. Loops the
// child's currently-active skills (already reconciled into child_skills by
// this point - see server/lib/skillProgress.js) and generates stage
// content for any that don't have any yet at their currently-available
// stage, with bounded concurrency.
async function maybeGenerateStageContentForNewSkills(childId, plan) {
  const { rows: skills } = await pool.query(
    'SELECT slug, title, description, icon, recommended_starting_stage FROM child_skills WHERE child_id = $1 AND active = true',
    [childId]
  );

  const toGenerate = [];
  for (const skill of skills) {
    const stage = await getAvailableStage(childId, skill.slug);
    if (!(await hasContentAtStage(childId, skill.slug, stage))) {
      toGenerate.push({ skill, stage });
    }
  }

  for (let i = 0; i < toGenerate.length; i += FANOUT_CONCURRENCY) {
    const batch = toGenerate.slice(i, i + FANOUT_CONCURRENCY);
    await Promise.all(batch.map(({ skill, stage }) => generateAndStoreStage(childId, plan, skill, stage)));
  }
}

// Called (fire-and-forget) whenever a child completes a stage attempt -
// completing a stage is what unlocks the next one (see getAvailableStage),
// but nothing else writes content for that newly-unlocked stage. Without
// this, a child could clear stage N and simply have nothing to play at
// stage N+1 until it happened to get backfilled some other way.
async function maybeGenerateStageContentForNextStage(childId, skillSlug) {
  const { rows: skillRows } = await pool.query(
    'SELECT slug, title, description, icon FROM child_skills WHERE child_id = $1 AND slug = $2',
    [childId, skillSlug]
  );
  if (skillRows.length === 0) return; // skill was deactivated/removed - don't keep growing its content
  const skill = skillRows[0];

  const stage = await getAvailableStage(childId, skillSlug);
  if (await hasContentAtStage(childId, skillSlug, stage)) return;

  const { rows: planRows } = await pool.query(
    'SELECT id, grade, parent_notes FROM learning_plans WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1',
    [childId]
  );
  if (planRows.length === 0) return;

  await generateAndStoreStage(childId, planRows[0], skill, stage);
}

module.exports = { maybeGenerateStageContentForNewSkills, maybeGenerateStageContentForNextStage };
