const config = require('../config/env');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(err);
  if (res.headersSent) return;
  const status = err.status || 500;
  const message = status === 500 && config.nodeEnv === 'production'
    ? 'Something went wrong'
    : err.message;
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
