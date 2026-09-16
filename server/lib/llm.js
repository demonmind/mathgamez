const config = require('../config/env');
const { isValidLearningPlanProfile, isValidSkillStageContent, isValidSkillVerification, SKILL_ICON_ALLOWLIST } = require('./validate');

function skillsSystemPrompt() {
  return `You are helping personalize a children's practice app called Number Quest (ages ~5-10, grades K-6). There is no fixed list of practice areas - your job is to read the parent's description of what their child struggles with (plus their grade, and any uploaded document) and decide which distinct SKILLS this child needs practice in. A skill can be anything grade-appropriate: a math topic (rounding, addition, subtraction, multiplication, fractions, telling time, money...), reading/language comprehension, spelling, vocabulary, or anything else a parent might reasonably describe. Different grades need different programs - do not assume any particular skill is always relevant.

Every stage of every skill you choose will later be generated fresh by another AI call and shown to the child as a 4-question multiple-choice quiz, so the skill itself doesn't need to fully specify content - just clearly name and describe the practice area.

Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after:
{
  "skills": [
    {
      "slug": "<a short kebab-case identifier, 2-32 chars, lowercase letters/digits/hyphens only, starting with a letter, e.g. "rounding-numbers">",
      "title": "<short human-readable title, e.g. "Rounding Numbers">",
      "description": "<one sentence describing exactly what this skill covers and at what level>",
      "icon": "<copy EXACTLY one of these emoji, verbatim: ${SKILL_ICON_ALLOWLIST.join(' ')}>",
      "recommendedStartingStage": <a positive integer, usually 1, higher only if the parent's notes suggest this child is already ahead in this specific skill>
    }
  ],
  "focusSummary": "<1-3 short sentences in plain language for the parent explaining your recommendation>"
}
Choose between 1 and 6 skills - as many as genuinely apply, no filler. If a CURRENT SKILL LIST is given below, and one of your skills covers the same underlying concept as an existing entry, you MUST reuse its exact "slug" and "title" unchanged so the child's progress in that skill carries forward - only mint a new slug for a genuinely new focus area. A skill you decide is no longer relevant should simply be omitted from your output - do not include it just to preserve history.`;
}

const SKILL_VERIFY_SYSTEM_PROMPT = `You are fact-checking a children's practice quiz. You will be given the skill it's for, an optional shared passage, and 4 multiple-choice questions with a marked correct answer each. For each question: if a passage is given, verify the marked answer is unambiguously supported by it; if no passage is given (e.g. a math question), INDEPENDENTLY work out the answer yourself, step by step, before checking - do not just trust the label. Also verify none of the other three options could reasonably be argued correct. Respond with ONLY a single JSON object, no markdown code fences, no commentary:
{
  "allValid": <true only if every question passes both checks, false otherwise>,
  "issues": [<0-based indices of any question that failed either check - empty array if allValid is true>]
}`;

function skillContentGenerateSystemPrompt(skill, stage) {
  return `You are writing practice content for a children's learning app, for the skill "${skill.title}" (${skill.description}). This is stage ${stage} for this child - stage 1 is introductory, and there is no fixed maximum stage, so each stage after the first should be moderately harder than the one before it. If you are given a performance summary below, use it to judge how much harder to make this stage; if not, use standard age/grade-appropriate difficulty for stage ${stage}.

If this skill is about reading, writing, or language comprehension, write ONE short original age-appropriate passage and set "sharedContext" to it; all 4 questions must then be answerable directly from that passage. For every other kind of skill (arithmetic, fractions, telling time, spelling, vocabulary, etc.), set "sharedContext" to null and make each of the 4 "questions" fully self-contained - put the whole problem, including any word-problem wording or the actual expression to solve, directly in that item's "question" field. Never include anything scary, violent, sad, or otherwise inappropriate for a young child.

Each question needs exactly 4 answer options with exactly one clearly, unambiguously correct answer - avoid ambiguous or trick questions. For arithmetic or any question with a computable answer, work the problem out carefully yourself before writing the answer key.

Respond with ONLY a single JSON object, no markdown code fences, no commentary. Schema:
{
  "title": "<short title for this stage>",
  "sharedContext": "<the passage, or null>",
  "questions": [
    {"question": "<self-contained question or prompt>", "options": ["<option 1>", "<option 2>", "<option 3>", "<option 4>"], "correctIndex": <0, 1, 2, or 3>}
  ]
}
"questions" must contain exactly 4 items.`;
}

const CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(CODE_FENCE_RE);
  return match ? match[1].trim() : trimmed;
}

// forceThinking: used for the math/other-non-passage verification pass,
// where the verifier has to actually COMPUTE an answer rather than check
// text comprehension - enable_thinking is otherwise disabled globally for
// latency (see config.llmDisableThinking), but arithmetic is a known weak
// spot for a small local model answering "from the hip", so this trades
// latency for a real shot at catching a wrong answer key on that one call.
async function callChatCompletion(messages, { forceThinking } = {}) {
  const controller = new AbortController();
  // LLM_TIMEOUT_MS=0 (the default) disables the abort entirely - stage
  // content generation now routinely involves multiple sequential calls
  // (generate + verify, sometimes with forced "thinking" - see
  // forceThinking below) that can legitimately run well past a minute, and
  // almost every caller in this file is a fire-and-forget background job
  // anyway (see server/lib/skillContentAuto.js), so there's no request
  // waiting on a clock. Set a positive value to restore a hard cutoff.
  const timeout = config.llmTimeoutMs > 0
    ? setTimeout(() => controller.abort(), config.llmTimeoutMs)
    : null;

  const disableThinking = config.llmDisableThinking && !forceThinking;

  let response;
  try {
    response = await fetch(`${config.llmApiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        temperature: 0.2,
        // Some Qwen3 builds default to an internal "thinking" pass before
        // answering, which can run to 1000+ tokens and take well over a
        // minute on an ambiguous/off-topic prompt - normally we only want
        // the final JSON, not a reasoning trace, so turn it off. Harmless
        // no-op on servers/models that don't recognize this field.
        ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const error = new Error(
      err.name === 'AbortError'
        ? 'The AI model took too long to respond - please try again'
        : 'Could not reach the local AI model - is it running?'
    );
    error.status = 422;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = new Error(`AI model request failed (${response.status})`);
    error.status = 422;
    throw error;
  }

  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    const error = new Error('The AI model returned an empty response');
    error.status = 422;
    throw error;
  }
  return content;
}

// Generic "ask for JSON matching a schema, retry once if it doesn't parse
// or validate" loop, shared by every LLM call in this file - never
// silently accepts malformed output.
async function runJsonPrompt(messages, isValidFn, retryReminder, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callChatCompletion(messages, opts);
    const jsonText = stripCodeFence(raw);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      parsed = null;
    }

    if (parsed && isValidFn(parsed)) {
      return parsed;
    }

    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: retryReminder });
  }
  return null;
}

const RETRY_REMINDER = 'That was not valid JSON matching the exact schema. Respond again with ONLY the JSON object, no other text.';

// documentImages (optional): [{ base64, mimeType }, ...] - each sent as an
// image content part for vision-capable models (see config.llmVisionCapable).
// documentExcerpt (optional): merged text extracted from any text/PDF
// uploads (see documentText.js's processDocuments) - a parent can attach
// several files at once (e.g. multiple pages of a worksheet), mixing
// text/PDF and image types freely.
// currentSkills (optional): the child's currently-active skills
// (child_skills rows), given so the model can reuse a matching slug
// instead of minting a new one for the same underlying concept.
async function generateLearningPlan({ grade, notes, documentExcerpt, documentImages, currentSkills }) {
  const textContent = [
    `Child's grade: ${grade}`,
    `Parent's description of what the child struggles with: ${notes}`,
    documentExcerpt ? `\nAdditional context from uploaded document(s):\n${documentExcerpt}` : '',
    documentImages && documentImages.length > 0
      ? `\n(${documentImages.length} image(s) of a document were also attached - use them as additional context.)`
      : '',
    currentSkills && currentSkills.length > 0
      ? `\nCURRENT SKILL LIST for this child (reuse a slug/title below if a new skill covers the same concept):\n${currentSkills.map((s) => `- slug: "${s.slug}", title: "${s.title}" - ${s.description}`).join('\n')}`
      : '',
  ].join('\n');

  const userMessage = documentImages && documentImages.length > 0
    ? {
        role: 'user',
        content: [
          { type: 'text', text: textContent },
          ...documentImages.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
        ],
      }
    : { role: 'user', content: textContent };

  const messages = [{ role: 'system', content: skillsSystemPrompt() }, userMessage];

  const profile = await runJsonPrompt(messages, isValidLearningPlanProfile, RETRY_REMINDER);
  if (!profile) {
    const error = new Error("The AI model didn't return a usable plan - please try again");
    error.status = 422;
    throw error;
  }
  return profile;
}

// Two independent LLM passes: generate the stage content, then a SEPARATE
// call (given only the skill, optional shared context, and answer key -
// not the original generation context) checks the answer key is actually
// correct. If verification fails, the whole stage is regenerated from
// scratch, up to 2 times - this is the safety net standing in for a
// deterministic checker, since content is now AI-authored for every skill
// (math included), not just reading. Never returns unverified content.
async function generateSkillStageContent({ grade, skill, stage, notes, performanceSummary }) {
  const userContent = [
    `Child's grade: ${grade}`,
    `Skill: ${skill.title} - ${skill.description}`,
    `Stage: ${stage} (1 = simplest; no fixed maximum)`,
    `What this child is working on / struggles with (from the parent): ${notes}`,
    performanceSummary ? `\nThis child's recent performance in this skill:\n${performanceSummary}` : '',
  ].join('\n');

  for (let regenAttempt = 0; regenAttempt < 2; regenAttempt++) {
    const genMessages = [
      { role: 'system', content: skillContentGenerateSystemPrompt(skill, stage) },
      { role: 'user', content: userContent },
    ];
    const content = await runJsonPrompt(
      genMessages,
      isValidSkillStageContent,
      'That was not valid JSON matching the exact schema (title, sharedContext, and questions with exactly 4 items, each with question/options[4]/correctIndex). Respond again with ONLY the JSON object.'
    );
    if (!content) continue;

    const verifyMessages = [
      { role: 'system', content: SKILL_VERIFY_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ skill: skill.title, sharedContext: content.sharedContext, questions: content.questions }) },
    ];
    // Force real "thinking" for the verify pass on non-passage (math/other
    // computable) content - see callChatCompletion's forceThinking comment.
    const verification = await runJsonPrompt(
      verifyMessages,
      isValidSkillVerification,
      'Respond again with ONLY the JSON object: {"allValid": true|false, "issues": [...]}.',
      { forceThinking: content.sharedContext === null }
    );

    if (verification && verification.allValid) {
      return content;
    }
    // Verification failed (or couldn't be parsed) - don't ship unverified
    // content, try fresh content instead of patching the flagged item.
  }

  const error = new Error("The AI model couldn't produce verified practice content - please try again");
  error.status = 422;
  throw error;
}

module.exports = { generateLearningPlan, generateSkillStageContent };
