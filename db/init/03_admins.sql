-- Superadmins are not part of any family - they're a separate operator
-- role for managing every family/parent/child on the instance. Deliberately
-- not seeded here; the app seeds the first admin from ADMIN_EMAIL/
-- ADMIN_PASSWORD env vars on boot (see server/app.js).
CREATE TABLE admins (
  id              BIGSERIAL PRIMARY KEY,
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
