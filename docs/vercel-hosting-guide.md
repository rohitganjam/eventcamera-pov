# Vercel Hosting Guide (3 Projects)

This guide sets up **3 Vercel projects** for POV EventCamera:

1. Organizer web frontend (`apps/web-organizer`)
2. Guest web frontend (`apps/web-guest`)
3. API backend (`apps/api`)

## Target domains

Use this mapping:

- Organizer web: `https://eventpovcamera.app`
- Guest web: `https://guest.eventpovcamera.app`
- API: `https://api.eventpovcamera.app`

## Prerequisites

1. Repo is connected to Vercel (GitHub/GitLab/Bitbucket).
2. Supabase project is ready.
3. Database migrations are applied at least once:
   - `npm run db:setup` (with API env loaded).
4. You have an `INTERNAL_CRON_API_TOKEN` value ready.

## Project 1: Organizer Web

Create a new Vercel project with:

- **Root Directory:** `apps/web-organizer`
- **Framework Preset:** `Next.js`
- **Build Command:** default (`next build`) is fine
- **Install Command:** default (`npm install`) is fine

Set environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `NEXT_PUBLIC_ORGANIZER_REDIRECT_URL=https://eventpovcamera.app`
- `NEXT_PUBLIC_API_BASE_URL=https://api.eventpovcamera.app`

Add custom domain:

- `eventpovcamera.app`

## Project 2: Guest Web

Create a second Vercel project with:

- **Root Directory:** `apps/web-guest`
- **Framework Preset:** `Next.js`
- **Build Command:** default (`next build`)
- **Install Command:** default (`npm install`)

Set environment variables:

- `NEXT_PUBLIC_API_BASE_URL=https://api.eventpovcamera.app`

Add custom domain:

- `guest.eventpovcamera.app`

## Project 3: API Backend

Create a third Vercel project with:

- **Root Directory:** `apps/api`
- **Framework Preset:** `Other`

Set environment variables:

- `PORT=3000`
- `ENABLE_CRON_JOBS=false`
- `INTERNAL_CRON_API_TOKEN=<strong-random-token>`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_DB_URL`
- `SUPABASE_STORAGE_ORIGINALS_BUCKET=originals`
- `SUPABASE_STORAGE_THUMBS_BUCKET=thumbs`
- `SUPABASE_STORAGE_ARCHIVE_BUCKET=archives`
- `SIGNED_URL_TTL_SECONDS=900`
- `GUEST_WEB_BASE_URL=https://guest.eventpovcamera.app`

Add custom domain:

- `api.eventpovcamera.app`

## Important note for API on Vercel

The API is an Express app. On Vercel, run it as a serverless HTTP function (not a long-running process).

If you have not already added a Vercel serverless entrypoint for `apps/api`, do that before production rollout.
The runtime is stateless/ephemeral, so in-process timers are not reliable.

This repo includes the entrypoint at:

- `apps/api/api/[...path].ts`

So routes like `/api/health` are handled by the Express app.

## Cron strategy (recommended)

Use **Supabase cron** to call the internal API sync endpoint, not in-process timers:

- Endpoint: `POST /api/internal/event-status-sync`
- Auth: `Authorization: Bearer <INTERNAL_CRON_API_TOKEN>`
- Schedule: `00:00` and `12:00` UTC

Use the full SQL/setup from:

- `docs/supabase-cron-setup.md`

## Deployment order

1. Deploy API project first (`api.eventpovcamera.app`).
2. Deploy Organizer web with API URL set to API domain.
3. Deploy Guest web with API URL set to API domain.
4. Configure Supabase cron last (after API is reachable).

## Smoke test checklist

1. `https://api.eventpovcamera.app/api/health` returns `200`.
2. Organizer login works on `https://eventpovcamera.app`.
3. Event creation works and returns guest URL on `guest.eventpovcamera.app`.
4. Guest join/upload flow works end-to-end.
5. Internal sync endpoint rejects invalid token and accepts valid token.
