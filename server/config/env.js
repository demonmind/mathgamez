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
  adminSessionMaxAgeMs: parseInt(process.env.ADMIN_SESSION_MAX_AGE_MS, 10) || 12 * 60 * 60 * 1000,
  // Optional: if both are set, the app seeds/updates this admin's password
  // on every boot - the only way to provision a superadmin (no public
  // signup route exists for this role).
  adminEmail: process.env.ADMIN_EMAIL || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  // OpenAI-compatible chat completions endpoint (llama.cpp's server, vLLM,
  // Ollama's /v1 shim, or a hosted provider all work). Swap LLM_API_BASE_URL
  // when the model changes - nothing else needs to change as long as the
  // new endpoint speaks the same /chat/completions shape.
  llmApiBaseUrl: process.env.LLM_API_BASE_URL || 'http://host.docker.internal:9002/v1',
  llmModel: process.env.LLM_MODEL || 'default',
  llmVisionCapable: process.env.LLM_VISION_CAPABLE !== 'false',
  llmApiKey: process.env.LLM_API_KEY || null,
  llmTimeoutMs: parseInt(process.env.LLM_TIMEOUT_MS, 10) || 90 * 1000,
  // How many completed stage attempts a child needs (since their last
  // learning plan update) before the background job re-runs the LLM to
  // re-calibrate their plan based on actual performance.
  autoRecalThreshold: parseInt(process.env.LEARNING_PLAN_AUTO_RECAL_THRESHOLD, 10) || 5,
};

module.exports = config;
