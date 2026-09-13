# Number Quest

A self-hosted, multi-family pirate-themed math game. Parents sign up, create
a family, and add kids; kids log in with a family code + avatar + 4-digit
PIN (no email/password) and play. Passing a stage at 85%+ accuracy earns 5
minutes of screen time, tracked in-app and redeemed manually by a parent in
real life.

## Stack

- Node.js + Express, plain HTML/CSS/vanilla JS frontend (no build step)
- PostgreSQL, schema applied via `db/init/*.sql` on first container start
- express-session with a Postgres-backed store (`connect-pg-simple`)
- Docker Compose: `app` + `db` services, named volume for Postgres data

## Setup

1. Copy the example env file and fill in real values:

   ```
   cp .env.example .env
   ```

   At minimum, set a real `POSTGRES_PASSWORD` and generate a `SESSION_SECRET`:

   ```
   openssl rand -base64 32
   ```

2. Build and start everything:

   ```
   docker compose up -d --build
   ```

3. Visit `http://localhost:3000` (or whatever `APP_PORT` you set).

4. Sign up as a parent, create your family, add your kids (name, avatar,
   4-digit PIN). Share the family code or the direct link shown on the
   dashboard (`/play/<CODE>`) with your kids so they can log in themselves.

## Viewing logs

```
docker compose logs -f app
docker compose logs -f db
```

## Resetting the database

`db/init/*.sql` only runs automatically against a **fresh, empty** Postgres
volume — it will not re-run or apply changes to an existing one. To start
completely fresh (this destroys all data — families, kids, progress,
rewards):

```
docker compose down -v
docker compose up -d --build
```

### Applying schema changes later (without wiping data)

If you edit `db/init/*.sql` after the volume already has data, run the new
SQL manually against the running container instead of wiping everything:

```
docker compose exec db psql -U <POSTGRES_USER> -d <POSTGRES_DB> -f /path/inside/container.sql
```

or pipe a local file in:

```
docker compose exec -T db psql -U <POSTGRES_USER> -d <POSTGRES_DB> < db/init/03_my_change.sql
```

This is a deliberate simplicity tradeoff (plain SQL init scripts instead of
a migration framework) - fine for a small self-hosted instance, but worth
revisiting if the schema starts changing often.

## Running behind a reverse proxy

The app works fine on a bare subpath-free subdomain or behind nginx/Caddy.
When you put a reverse proxy in front of it:

- Set `TRUST_PROXY=1` (or the correct hop count) in `.env` so Express trusts
  the proxy's `X-Forwarded-*` headers.
- Set `COOKIE_SECURE=true` once the proxy terminates HTTPS - browsers drop
  cookies marked `secure` over plain HTTP, so leave this `false` until TLS
  is actually in front of the app.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto` from your proxy config
  (both nginx and Caddy do this by default).

## Security notes

- Parent passwords and kid PINs are hashed with bcrypt; PINs are never
  emailed or shown in plaintext after creation.
- Parent login, signup, and child PIN login are all rate-limited
  (`server/middleware/rateLimiters.js`).
- Every child/family-scoped query is filtered server-side by the session's
  `family_id`/`child_id` - never by a client-supplied id alone.
- Accuracy and reward-granting are computed entirely server-side
  (`server/routes/game.js`); the client only reports individual right/wrong
  answers, never a final accuracy figure.
- A family is capped at 2 parent accounts, enforced by a Postgres trigger
  (race-proof) plus an app-level pre-check for a friendlier error message.

## Project layout

```
db/init/        SQL run once against a fresh Postgres volume
server/         Express app, routes, middleware, db pool
public/         Static HTML/CSS/JS frontend (no build step)
```
