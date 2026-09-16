const AVATAR_EMOJI_ALLOWLIST = [
  '🏴‍☠️', '🦜', '⚓', '🐙', '🦈', '🧜', '🐢', '🦀', '🐬', '⛵',
  '🗺️', '💰', '🏝️', '🦑', '🐳', '🌊', '👑', '🔱', '🦩', '🐠',
];

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
}

function isValidPin(value) {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}

function hasControlChar(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isValidDisplayName(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 40 && !hasControlChar(trimmed);
}

function isValidAvatarEmoji(value) {
  return AVATAR_EMOJI_ALLOWLIST.includes(value);
}

const SKILL_SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

// AI-chosen skill identifier - used as a DB value, a URL path segment, and
// a CSS class suffix, so the charset is deliberately restrictive (never
// trust model output shape - see isValidLearningPlanProfile below).
function isValidSkillSlug(value) {
  return typeof value === 'string' && SKILL_SLUG_RE.test(value);
}

// Kept as an alias since "game mode" is now just "skill slug" throughout
// the attempt-tracking routes - same validation, same DB column.
const isValidGameMode = isValidSkillSlug;

function isValidStage(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1;
}

const SKILL_ICON_ALLOWLIST = [
  '🧭', '🗺️', '🔢', '➕', '➖', '✖️', '➗', '📖', '🔤', '🧮',
  '📏', '⏰', '🧩', '🌍', '🔬', '🎨', '💰', '🧠', '📐', '🗣️',
];

function isValidSkillIcon(value) {
  return SKILL_ICON_ALLOWLIST.includes(value);
}

function isValidSkillTitle(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 60 && !hasControlChar(trimmed);
}

function isValidSkillDescription(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 240 && !hasControlChar(trimmed);
}

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Accepts a bare 11-char YouTube video ID, or a full watch/share/embed URL
// (youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, .../embed/,
// youtube-nocookie.com/embed/), and extracts just the video ID. Returns
// null if the input doesn't look like a single specific YouTube video -
// callers must never fall back to treating unparsed input as "close enough".
function parseYoutubeVideoId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (YOUTUBE_ID_RE.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1);
      return YOUTUBE_ID_RE.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        return id && YOUTUBE_ID_RE.test(id) ? id : null;
      }
      const match = url.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/);
      if (match) return match[1];
    }
  } catch (e) {
    return null;
  }
  return null;
}

function isValidYoutubeVideoId(value) {
  return typeof value === 'string' && YOUTUBE_ID_RE.test(value);
}

// Google API keys don't have one fixed universal format, so this is a
// loose sanity check (reasonable length, no whitespace/control chars) -
// the real validation is whether the YouTube API actually accepts it.
function isValidApiKey(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 10 && trimmed.length <= 200 &&
    !hasControlChar(trimmed) && !/\s/.test(trimmed);
}

function isValidSearchQuery(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 100 && !hasControlChar(trimmed);
}

function isValidVideoTitle(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 && !hasControlChar(trimmed);
}

// Minutes spent watching must be a positive multiple of 5 (matches the
// fixed 5-minute reward chunks in reward_ledger).
function isValidWatchMinutes(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n % 5 === 0;
}

const GRADE_ALLOWLIST = ['Pre-K', 'K', '1st', '2nd', '3rd', '4th', '5th', '6th+'];

function isValidGrade(value) {
  return GRADE_ALLOWLIST.includes(value);
}

function isValidLearningPlanNotes(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 2000 && !hasControlChar(trimmed);
}

// A single AI-proposed skill. slug/title/description/icon are each
// strictly bounded (see above) since slug becomes a DB value/URL
// segment/CSS class and title/description get rendered as kid-facing text.
function isValidSkill(value) {
  if (!value || typeof value !== 'object') return false;
  if (!isValidSkillSlug(value.slug)) return false;
  if (!isValidSkillTitle(value.title)) return false;
  if (!isValidSkillDescription(value.description)) return false;
  if (!isValidSkillIcon(value.icon)) return false;
  if (!Number.isInteger(value.recommendedStartingStage) || value.recommendedStartingStage < 1) return false;
  return true;
}

// 1-6 skills (also a cost/latency control - plan creation fans out one
// two-pass generation per skill), unique slugs (case-insensitive).
function isValidSkillsArray(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return false;
  if (!value.every(isValidSkill)) return false;
  const slugs = value.map((s) => s.slug.toLowerCase());
  return new Set(slugs).size === slugs.length;
}

// Strictly validates the LLM's JSON output against the exact schema given
// in the system prompt - never trust model output shape. There's no fixed
// taxonomy any more: the AI decides which skills apply to this child from
// the parent's notes + grade, so this only bounds shape/count/format, not
// which skills are allowed.
function isValidLearningPlanProfile(value) {
  if (!value || typeof value !== 'object') return false;
  if (!isValidSkillsArray(value.skills)) return false;
  if (typeof value.focusSummary !== 'string' ||
      value.focusSummary.length < 1 || value.focusSummary.length > 500) return false;
  return true;
}

function isValidSkillContentOption(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= 200 && !hasControlChar(value);
}

// Strictly validates the LLM's generated stage content against the exact
// schema given in the system prompt - this becomes actual kid-facing
// content, so shape and question count must be exact. sharedContext is
// nullable: reading/language skills use it as a shared passage for all 4
// questions, other skills (math, etc.) leave it null and make each
// question fully self-contained.
function isValidSkillStageContent(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.title !== 'string' || value.title.trim().length < 1 || value.title.length > 200) return false;
  if (value.sharedContext !== null &&
      (typeof value.sharedContext !== 'string' || value.sharedContext.trim().length < 20 || value.sharedContext.length > 4000)) return false;
  if (!Array.isArray(value.questions) || value.questions.length !== 4) return false;
  for (const q of value.questions) {
    if (!q || typeof q !== 'object') return false;
    if (typeof q.question !== 'string' || q.question.trim().length < 1 || q.question.length > 500) return false;
    if (!Array.isArray(q.options) || q.options.length !== 4) return false;
    if (!q.options.every(isValidSkillContentOption)) return false;
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) return false;
  }
  return true;
}

// Strictly validates the independent verification pass's output.
function isValidSkillVerification(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.allValid !== 'boolean') return false;
  if (!Array.isArray(value.issues)) return false;
  return value.issues.every((i) => Number.isInteger(i));
}

module.exports = {
  AVATAR_EMOJI_ALLOWLIST,
  isValidEmail,
  isValidPassword,
  isValidPin,
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidGameMode,
  isValidStage,
  isValidSkillSlug,
  SKILL_ICON_ALLOWLIST,
  isValidSkillIcon,
  isValidSkillTitle,
  isValidSkillDescription,
  isValidSkill,
  isValidSkillsArray,
  parseYoutubeVideoId,
  isValidYoutubeVideoId,
  isValidApiKey,
  isValidSearchQuery,
  isValidVideoTitle,
  isValidWatchMinutes,
  GRADE_ALLOWLIST,
  isValidGrade,
  isValidLearningPlanNotes,
  isValidLearningPlanProfile,
  isValidSkillStageContent,
  isValidSkillVerification,
};
