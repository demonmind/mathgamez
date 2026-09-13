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

module.exports = {
  parentLoginLimiter,
  parentSignupLimiter,
  childPinLimiter,
  childPinIpLimiter,
};
