const rateLimit = require('express-rate-limit');

const parentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

const parentSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts, please try again later' },
});

// Keyed by IP + childId so one family's cap isn't exhausted by a sibling
// mistyping their PIN, while still limiting brute force against one child.
const childPinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body && req.body.childId}`,
  message: { error: 'Too many attempts, please wait a few minutes and try again' },
});

// Defense in depth: blunts one IP hammering many different childIds to
// route around the per-child cap above.
const childPinIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please wait a few minutes and try again' },
});

// Tighter than the parent limiter - this account can see/delete every
// family on the instance, so it's a higher-value target for brute force.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// Protects a family's YouTube API quota (and the free tier's daily cap)
// from being burned through by rapid-fire searches.
const videoSearchLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches, please wait a bit and try again' },
});

// LLM generation is slow and compute-heavy (runs on the host's GPU) -
// bounds how often a parent can trigger it per child.
const learningPlanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many plan requests, please wait a bit and try again' },
});

module.exports = {
  parentLoginLimiter,
  parentSignupLimiter,
  childPinLimiter,
  childPinIpLimiter,
  adminLoginLimiter,
  videoSearchLimiter,
  learningPlanLimiter,
};
