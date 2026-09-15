const config = require('../config/env');
const { isValidLearningPlanProfile } = require('./validate');

const SYSTEM_PROMPT = `You are helping tune a children's math practice app called Number Quest (ages ~5-10, grades K-6). The app has two game modes ("round" = rounding numbers, "addsub" = 3-number addition/subtraction) each with 3 fixed stages of increasing difficulty. You do NOT write any math questions or answers yourself - the app's own code generates every question deterministically. Your only job is to output a small JSON object of tuning knobs based on the child's grade and what the parent says they struggle with, plus a short plain-language note for the parent.

Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after. It must have exactly these fields:
{
  "recommendedMode": "round" | "addsub" | "both",
  "recommendedStartingStage": 1 | 2 | 3,
  "subtractionEmphasis": <number between 0 and 1, how much to favor subtraction over addition practice>,
  "extraWordProblems": <true or false>,
  "numberRangeAdjustment": "smaller" | "standard" | "larger",
  "focusSummary": "<1-3 short sentences in plain language for the parent explaining your recommendation>"
}`;

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

// One retry with a stricter reminder if the model doesn't return valid
// JSON matching the schema - never silently accepts malformed output,
// since this feeds directly into what math problems a child practices.
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    userMessage,
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callChatCompletion(messages);
    const jsonText = stripCodeFence(raw);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      parsed = null;
    }

    if (parsed && isValidLearningPlanProfile(parsed)) {
      return parsed;
    }

    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: 'That was not valid JSON matching the exact schema. Respond again with ONLY the JSON object, no other text.',
    });
  }

  const error = new Error("The AI model didn't return a usable plan - please try again");
  error.status = 422;
  throw error;
}

module.exports = { generateLearningPlan };
