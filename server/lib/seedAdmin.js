const bcrypt = require('bcrypt');
const config = require('../config/env');
const pool = require('../db/pool');

const BCRYPT_ROUNDS = 12;

// The only way to provision a superadmin: set ADMIN_EMAIL/ADMIN_PASSWORD in
// .env and restart. Upserts on every boot so rotating the password in .env
// and restarting is enough to change it - there's no public signup route
// for this role, deliberately.
async function seedAdminFromEnv() {
  if (!config.adminEmail || !config.adminPassword) return;

  const passwordHash = await bcrypt.hash(config.adminPassword, BCRYPT_ROUNDS);
  await pool.query(
    `INSERT INTO admins (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [config.adminEmail, passwordHash]
  );
  console.log(`Superadmin account ready for ${config.adminEmail}`);
}

module.exports = seedAdminFromEnv;
