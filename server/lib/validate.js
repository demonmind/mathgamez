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

module.exports = {
  AVATAR_EMOJI_ALLOWLIST,
  isValidEmail,
  isValidPassword,
  isValidPin,
  isValidDisplayName,
  isValidAvatarEmoji,
  isValidGameMode,
  isValidStage,
};
