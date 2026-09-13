const config = require('./config/env');
const createApp = require('./app');

const app = createApp();

app.listen(config.port, () => {
  console.log(`Number Quest listening on port ${config.port} (env: ${config.nodeEnv})`);
});
