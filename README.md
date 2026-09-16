# Number Quest

A self-hosted, multi-family pirate-themed math game. Parents sign up, create
a family, and add kids; kids log in with a family code + avatar + 4-digit
PIN (no email/password) and play. Passing a stage at 85%+ accuracy earns 5
minutes of screen time, which a kid can either redeem manually with a
parent for real-life screen time, or spend in-app to watch a video a
parent specifically approved.

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

## AI-generated learning plans & Story Cove

A parent can describe what a child struggles with (plus an optional
document - text, PDF, or a photo for vision-capable models) on the
dashboard, and a locally-run LLM (any OpenAI-compatible
`/chat/completions` endpoint - llama.cpp's server, vLLM, etc; see
`LLM_API_BASE_URL`) returns a small, strictly-validated set of tuning
knobs. Critically, **the model never writes or grades math itself** - it
only adjusts parameters (number ranges, how much to emphasize subtraction,
starting stage, etc.) that bias the existing deterministic question
generators in `public/js/game.js`.

If a plan flags `includeReadingPractice`, that also kicks off a background
job that writes a **Story Cove** reading passage: a short age-appropriate
story plus 4 multiple-choice comprehension questions. Since there's no
deterministic correctness check for reading comprehension the way there is
for arithmetic, this uses a **two-pass generate-then-verify** pattern
(`server/lib/llm.js`): one LLM call writes the passage and answer key, a
*second, independent* call is given only the passage and the proposed
answer key and checks whether each marked-correct answer is actually
supported by the text. If verification fails, the whole passage is
regenerated from scratch (up to 2 attempts) - nothing is published
unverified. This runs automatically, with no parent approval step, but
every plan and passage is visible on the dashboard.

A background job also periodically **re-calibrates** an existing plan
using the child's actual recent accuracy (not a parent's words) - see
`LEARNING_PLAN_AUTO_RECAL_THRESHOLD` and the per-child "auto-adjust"
toggle on the dashboard. None of this ever blocks gameplay: every LLM call
here is triggered fire-and-forget from a route that already returned its
response to the child.

Generating a new plan for a child **replaces** what's currently tuning
their gameplay (it doesn't merge with the previous one) - the dashboard
keeps every earlier plan under "Earlier plans" so you can bring back an
older set of notes if a new plan wasn't what you meant to change.

Every plan (current or earlier) also has an **"Edit this prompt"** button -
unlike generating a new plan, this updates that same plan's grade/notes in
place and re-runs the LLM on the edited text. It becomes the active plan
again immediately, even if you edited one from "Earlier plans."

## Watch-a-video reward redemption

Besides the parent's manual "Mark as Redeemed" button, a kid can spend their
own treasure minutes in-app to watch a video - either from a **parent-
curated allowlist** (default, always available), or, if a parent opts in,
by **searching YouTube directly**. Videos play embedded via
`youtube-nocookie.com` with no related-video suggestions or comments.

Minutes are spent the moment a kid chooses to watch (same "spend it, no
refund" model as the parent's manual redeem) - there's no server-side
tracking of actual watch time, just of how many minutes were chosen to
redeem for that video. The parent's reward history shows which video was
watched for each self-redeemed entry, including search-based picks.

### Optional: open video search

Off by default. A parent enables it per-family from the dashboard's "Video
Search" section by pasting their own YouTube Data API v3 key (free from
[Google Cloud Console](https://console.cloud.google.com/apis/credentials) -
enable "YouTube Data API v3" on a project, then create an API key under
Credentials). The key is write-only from the browser's perspective - it's
never sent back in any API response after saving.

Search results are filtered with YouTube's `safeSearch=strict` parameter,
which is a best-effort content filter, **not a guarantee** - inappropriate
or ad-heavy content can still surface. This tradeoff is stated plainly in
the dashboard UI; only enable it if you're comfortable with it. The search
call happens entirely server-side (`server/lib/youtube.js`) so the API key
never reaches the browser, and is rate-limited per child
(`videoSearchLimiter`) to protect the family's API quota.

## Superadmin console

There's an optional operator role that can view and manage every family,
parent, and child on the instance - for you, not the neighbor families. It
has no public signup form; you provision it via `.env`:

```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=some-strong-password
```

Restart the `app` service (`docker compose up -d app`) and the account is
created/updated automatically on boot - changing `ADMIN_PASSWORD` and
restarting rotates the password. Leave both blank to disable the feature
entirely (no admin account exists, and the login route just rejects
everything).

Log in at `/admin/login.html`. From there you can see every family's code,
parent(s), and children; reset a parent's password or a child's PIN; delete
a single parent or child; or delete an entire family (cascades to that
family's parents, children, game history, and reward ledger - irreversible).

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

### If you're behind Cloudflare specifically

Cloudflare caches static file extensions (`.js`, `.css`, etc.) at its edge
*and* tells browsers to cache them, using its own default Browser Cache TTL
(commonly 4 hours) - **regardless of what this app's origin sends** (Express
already sends `Cache-Control: max-age=0`, i.e. "always revalidate," but
Cloudflare overrides it for these file types on most plans).

To work around this without needing to touch Cloudflare's dashboard, every
`<script src>`/`<link rel=stylesheet>` in `public/**/*.html` is suffixed
with a version query string (`?v=1`) - Cloudflare and browsers cache each
`?v=N` URL independently, so bumping that number is enough to force
everyone to fetch the new file immediately, without waiting out the TTL or
purging anything. **After any deploy that changes a file under
`public/js/` or `public/css/`, bump the `?v=N` value** (a single
find-and-replace across `public/**/*.html` is enough - grep for `?v=1` to
find every occurrence).

## Security notes

- Parent passwords and kid PINs are hashed with bcrypt; PINs are never
  emailed or shown in plaintext after creation.
- Parent login, signup, child PIN login, and admin login are all
  rate-limited (`server/middleware/rateLimiters.js`) - the admin limiter is
  the tightest, since that account can see/delete every family.
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
