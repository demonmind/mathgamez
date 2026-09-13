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
const familyRoutes = require('./routes/family');
const kidsRoutes = require('./routes/kids');
const gameRoutes = require('./routes/game');
const rewardsRoutes = require('./routes/rewards');

function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
      },
    },
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
  app.use('/api/family', familyRoutes);
  app.use('/api/kids', kidsRoutes);
  app.use('/api/game', gameRoutes);
  app.use('/api/rewards', rewardsRoutes);

  // Direct family link (e.g. bookmarked/QR-coded by a parent) - lets a kid
  // skip typing the family code. Static-file serving can't match this
  // dynamic path, so it's handled as an explicit route.
  app.get('/play/:code', (req, res) => {
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
