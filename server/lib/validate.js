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

function isValidGameMode(value) {
  return value === 'round' || value === 'addsub';
}

function isValidStage(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3;
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

module.exports = {
  AVATAR_EMOJI_ALLOWLIST,
  isValidEmail,
  isValidPassword,
  isValidPin,
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidGameMode,
  isValidStage,
  parseYoutubeVideoId,
  isValidYoutubeVideoId,
  isValidApiKey,
  isValidSearchQuery,
  isValidVideoTitle,
  isValidWatchMinutes,
};
