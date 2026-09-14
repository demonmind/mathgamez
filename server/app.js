const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./config/env');
const pool = require('./db/pool');
const errorHandler = require('./middleware/errorHandler');

const authParentRoutes = require('./routes/auth.parent');
const authChildRoutes = require('./routes/auth.child');
const authAdminRoutes = require('./routes/auth.admin');
const familyRoutes = require('./routes/family');
const kidsRoutes = require('./routes/kids');
const gameRoutes = require('./routes/game');
const rewardsRoutes = require('./routes/rewards');
const adminRoutes = require('./routes/admin');
const videosRoutes = require('./routes/videos');

function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // i.ytimg.com serves YouTube search-result thumbnails (search is
        // opt-in per family - see the video search feature).
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        // Curated, parent-approved videos only - embedded via the
        // privacy-enhanced nocookie domain (no related-video suggestions).
        frameSrc: ["'self'", 'https://www.youtube-nocookie.com'],
      },
    },
    // helmet's default is 'no-referrer', which breaks the YouTube embed
    // player (it rejects the request with "Error 153" when it gets no
    // referrer at all). 'strict-origin-when-cross-origin' still only leaks
    // the origin (not the full path) to cross-origin destinations.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  app.use(express.json({ limit: '32kb' }));

  app.use(session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: config.sessionSecret,
    name: 'nq.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.parentSessionMaxAgeMs,
    },
  }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  app.use('/api/auth/parent', authParentRoutes);
  app.use('/api/auth/child', authChildRoutes);
  app.use('/api/auth/admin', authAdminRoutes);
  app.use('/api/family', familyRoutes);
  app.use('/api/kids', kidsRoutes);
  app.use('/api/game', gameRoutes);
  app.use('/api/rewards', rewardsRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/videos', videosRoutes);

  // Direct family link (e.g. bookmarked/QR-coded by a parent) - lets a kid
  // skip typing the family code. Static-file serving can't match this
  // dynamic path, so it's handled as an explicit route. Constrained to the
  // actual family-code shape so it can't shadow real static files like
  // /play/index.html or /play/family.html (":code" alone would match those
  // too, since they're also single path segments).
  app.get('/play/:code([A-Za-z0-9]{6})', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'play', 'family.html'));
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
