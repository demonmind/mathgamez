const config = require('../config/env');
const { isValidLearningPlanProfile, isValidReadingPassage, isValidReadingVerification } = require('./validate');

const SYSTEM_PROMPT = `You are helping tune a children's practice app called Number Quest (ages ~5-10, grades K-6). It has three practice areas: "round" (rounding numbers), "addsub" (3-number addition/subtraction), and "reading" (short reading passages with comprehension questions). Math questions are generated deterministically by the app's own code and reading passages are generated separately (you never write math questions/answers here). Your only job here is to output a small JSON object of tuning knobs based on the child's grade and what the parent says they struggle with, plus a short plain-language note for the parent.

Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after. It must have exactly these fields:
{
  "recommendedMode": "round" | "addsub" | "both",
  "recommendedStartingStage": 1 | 2 | 3,
  "subtractionEmphasis": <number between 0 and 1, how much to favor subtraction over addition practice>,
  "extraWordProblems": <true or false>,
  "numberRangeAdjustment": "smaller" | "standard" | "larger",
  "includeReadingPractice": <true if the parent's description suggests reading/comprehension practice would help this child, even if their main struggle isn't math - false otherwise>,
  "focusSummary": "<1-3 short sentences in plain language for the parent explaining your recommendation>"
}`;

const READING_VERIFY_SYSTEM_PROMPT = `You are fact-checking a children's reading comprehension quiz. You will be given a passage and a set of multiple-choice questions with a marked correct answer for each. For each question, verify: (1) the marked correct answer is actually and unambiguously supported by the passage text, and (2) none of the other three options could also reasonably be considered correct or arguable. Respond with ONLY a single JSON object, no markdown code fences, no commentary:
{
  "allValid": <true only if every question passes both checks, false otherwise>,
  "issues": [<0-based indices of any question that failed either check - empty array if allValid is true>]
}`;

function readingGenerateSystemPrompt(stage) {
  const lengthGuide = {
    1: 'short and simple (about 60-100 words), simple sentences, a clear beginning/middle/end',
    2: 'medium length (about 120-200 words), a bit more complex sentence structure and vocabulary',
    3: 'longer (about 200-350 words), richer vocabulary, and may require some inference beyond what is stated directly',
  }[stage] || 'short and simple (about 60-100 words)';

  return `You are writing a short reading passage and comprehension quiz for a children's reading practice app. Write ONE original, wholesome, age-appropriate passage (a simple story or a nonfiction topic a child would find interesting - animals, adventure, friendship, nature, space, etc.) that is ${lengthGuide}. Never include anything scary, violent, sad, or otherwise inappropriate for a young child.

Then write exactly 4 multiple-choice comprehension questions about the passage. Each question must have exactly 4 answer options with exactly one clearly correct answer directly supported by the passage text - avoid ambiguous or trick questions.

Respond with ONLY a single JSON object, no markdown code fences, no commentary. Schema:
{
  "title": "<short title>",
  "passageText": "<the passage>",
  "questions": [
    {"question": "<question text>", "options": ["<option 1>", "<option 2>", "<option 3>", "<option 4>"], "correctIndex": <0, 1, 2, or 3>}
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

async function callChatCompletion(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);

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
        // minute on an ambiguous/off-topic prompt - we only want the final
        // JSON, not a reasoning trace, so turn it off. Harmless no-op on
        // servers/models that don't recognize this field.
        ...(config.llmDisableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
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
    clearTimeout(timeout);
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
async function runJsonPrompt(messages, isValidFn, retryReminder) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callChatCompletion(messages);
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

// documentImage (optional): { base64, mimeType } - sent as an image content
// part for vision-capable models (see config.llmVisionCapable). Mutually
// exclusive with documentExcerpt (text extracted from a PDF/text upload).
async function generateLearningPlan({ grade, notes, documentExcerpt, documentImage }) {
  const textContent = [
    `Child's grade: ${grade}`,
    `Parent's description of what the child struggles with: ${notes}`,
    documentExcerpt ? `\nAdditional context from an uploaded document:\n${documentExcerpt}` : '',
    documentImage ? '\n(An image of a document was also attached - use it as additional context.)' : '',
  ].join('\n');

  const userMessage = documentImage
    ? {
        role: 'user',
        content: [
          { type: 'text', text: textContent },
          { type: 'image_url', image_url: { url: `data:${documentImage.mimeType};base64,${documentImage.base64}` } },
        ],
      }
    : { role: 'user', content: textContent };

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, userMessage];

  const profile = await runJsonPrompt(messages, isValidLearningPlanProfile, RETRY_REMINDER);
  if (!profile) {
    const error = new Error("The AI model didn't return a usable plan - please try again");
    error.status = 422;
    throw error;
  }
  return profile;
}

// Two independent LLM passes: generate the passage+quiz, then a SEPARATE
// call (given only the passage and answer key, not the original generation
// context) checks the answer key is actually correct. If verification
// fails, the whole passage is regenerated from scratch, up to 2 times -
// this is the safety net standing in for a deterministic checker, since
// there isn't one for reading comprehension the way there is for
// arithmetic. Never returns unverified content.
async function generateReadingPassage({ grade, stage, notes }) {
  const userContent = [
    `Child's grade: ${grade}`,
    `Stage: ${stage} (1 = simplest, 3 = most advanced)`,
    `What this child is working on / struggles with: ${notes}`,
  ].join('\n');

  for (let regenAttempt = 0; regenAttempt < 2; regenAttempt++) {
    const genMessages = [
      { role: 'system', content: readingGenerateSystemPrompt(stage) },
      { role: 'user', content: userContent },
    ];
    const passage = await runJsonPrompt(
      genMessages,
      isValidReadingPassage,
      'That was not valid JSON matching the exact schema (title, passageText, and questions with exactly 4 items, each with question/options[4]/correctIndex). Respond again with ONLY the JSON object.'
    );
    if (!passage) continue;

    const verifyMessages = [
      { role: 'system', content: READING_VERIFY_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ passageText: passage.passageText, questions: passage.questions }) },
    ];
    const verification = await runJsonPrompt(
      verifyMessages,
      isValidReadingVerification,
      'Respond again with ONLY the JSON object: {"allValid": true|false, "issues": [...]}.'
    );

    if (verification && verification.allValid) {
      return passage;
    }
    // Verification failed (or couldn't be parsed) - don't ship unverified
    // content, try a fresh passage instead of patching the flagged item.
  }

  const error = new Error("The AI model couldn't produce a verified reading passage - please try again");
  error.status = 422;
  throw error;
}

module.exports = { generateLearningPlan, generateReadingPassage };
