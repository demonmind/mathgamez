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

## AI-generated learning plans & skill tiles

A parent describes what a child struggles with (plus up to 5 optional
documents - text, PDF, and/or photos for vision-capable models, mixed
types allowed) on the dashboard, and a locally-run LLM (any
OpenAI-compatible `/chat/completions` endpoint - llama.cpp's server, vLLM,
etc; see `LLM_API_BASE_URL`) decides which
**skills** apply to this child - there's no fixed taxonomy of practice
areas, since different grades and kids need different programs. Each skill
becomes one tile in the game (`GET /api/game/learning-plan`), and a child
with no plan yet simply sees no tiles.

Every stage of every skill is itself AI-generated content (a short shared
passage plus multiple-choice questions for reading/language skills, or
fully self-contained questions for everything else - arithmetic, spelling,
telling time, etc. - see `QUESTIONS_PER_STAGE`, default 8), written and
cached once, then replayed. **This is a
deliberate step down from an earlier design where math was 100%
deterministic** - the model can occasionally get an arithmetic answer key
wrong the same way it can misjudge anything else. The mitigation is a
**two-pass generate-then-verify** pattern (`server/lib/llm.js`): one call
writes the stage's content, a *second, independent* call re-derives each
answer from scratch (actually computing it for math-like content, not just
checking comprehension) before it ships; if verification fails, the whole
stage is regenerated (up to 2 attempts) - nothing unverified is shown to a
child. The verification pass re-enables the model's "thinking" mode
specifically for non-passage content, trading latency for a better shot at
catching a wrong computation (see `forceThinking` in `llm.js`).

There's no request timeout on LLM calls by default (`LLM_TIMEOUT_MS=0`) -
a multi-skill plan can fan out several two-pass generations back to back,
and almost every call happens in a fire-and-forget background job anyway,
so nothing is left waiting on a clock. Set `LLM_TIMEOUT_MS` to a positive
number of milliseconds if you want a hard cutoff restored.

Passing a stage requires 90% accuracy and stages are uncapped - difficulty
scales relative to a child's own recent accuracy in that skill (fed into
each new stage's generation call), not a fixed table. Already-passed
stages are shown with a checkmark in the stage picker, distinct from
unlocked-but-not-yet-tried ones.

A background job also periodically **re-calibrates** an existing plan's
skill list using the child's actual recent accuracy (not just a parent's
words) - see `LEARNING_PLAN_AUTO_RECAL_THRESHOLD` and the per-child
"auto-adjust" toggle on the dashboard. None of this ever blocks gameplay:
every LLM call here is triggered fire-and-forget from a route that already
returned its response to the child.

Generating a new plan **replaces** the child's active skill list (it
doesn't merge with the previous one) - a skill the new plan still covers
keeps its exact slug and all its stage history/content; a skill dropped
from the new plan simply stops appearing as a tile, its history isn't
deleted. The dashboard keeps every earlier plan under "Earlier plans" so
you can bring back an older set of notes if a new plan wasn't what you
meant to change, and every plan (current or earlier) has an **"Edit this
prompt"** button - unlike generating a new plan, this updates that same
plan's grade/notes in place and re-runs the LLM on the edited text,
becoming the active plan again immediately.

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

Cloudflare's edge also enforces its own ~100 second timeout on proxied HTTP
requests (a 524 error past that point), independent of this app's own
`LLM_TIMEOUT_MS`. That doesn't affect content generation itself - it's
fire-and-forget and outlives the request that triggered it - but the
*initial* skill-extraction call in `POST/PATCH .../learning-plan` is
awaited before responding to the parent, so a parent's plan-generation
request could still hit a Cloudflare 524 if that one call alone runs past
~100s, even though the app itself has no timeout.

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
