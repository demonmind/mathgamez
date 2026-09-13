require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxy: parseInt(process.env.TRUST_PROXY, 10) || 0,
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  parentSessionMaxAgeMs: parseInt(process.env.PARENT_SESSION_MAX_AGE_MS, 10) || 12 * 60 * 60 * 1000,
  childSessionMaxAgeMs: parseInt(process.env.CHILD_SESSION_MAX_AGE_MS, 10) || 4 * 60 * 60 * 1000,
};

module.exports = config;
