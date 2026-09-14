const config = require('./config/env');
const createApp = require('./app');
const seedAdminFromEnv = require('./lib/seedAdmin');

const app = createApp();

seedAdminFromEnv()
  .catch((err) => console.error('Failed to seed admin account:', err))
  .finally(() => {
    app.listen(config.port, () => {
      console.log(`Number Quest listening on port ${config.port} (env: ${config.nodeEnv})`);
    });
  });
