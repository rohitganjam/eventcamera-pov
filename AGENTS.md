# AGENTS.md

Project-level coding instructions for Codex and other coding agents.

## 1. Product Context

- App name: `POV EventCamera`
- Primary domains:
  - Organizer web: `https://www.eventpovcamera.app` (with `eventpovcamera.app` redirecting here)
  - Guest web: `https://guest.eventpovcamera.app`
  - API: `https://api.eventpovcamera.app`
- Architecture: monorepo with separate organizer and guest apps.

## 2. Source of Truth

When behavior or contracts change, keep these in sync:

1. Backend implementation (`apps/api/src/**`)
2. OpenAPI (`openapi/poveventcam.yaml`)
3. Docs (`docs/**`)
4. API client types (`packages/api-client/**`)

Do not leave docs/spec stale after implementing behavior changes.
- Also update relevant docs for architecture, setup, UX flows, and operational changes whenever implementation changes affect them.

## 3. Monorepo Layout and Stack

- API: `apps/api` (Node.js + TypeScript + Express)
- Organizer web: `apps/web-organizer` (Next.js)
- Guest web: `apps/web-guest` (Next.js, mobile-first design)
- Shared API client: `packages/api-client`
- DB: Supabase Postgres
- Organizer auth: Supabase Auth
- Object storage: Cloudflare R2 (`originals`, `thumbs`, `archives`)

Do not reintroduce Vite for organizer/guest web apps.

## 4. API and Auth Rules

### Organizer auth

- Preferred web auth path:
  - Supabase login in web app
  - Exchange bearer token via `POST /api/organizer/auth/session`
  - Use HttpOnly cookie `organizer_session_token` for organizer API calls
- Bearer auth remains supported as fallback for non-browser clients.
- Protect mutating organizer routes with CSRF origin/referer checks when using cookie auth.

### Guest auth

- Guest identity is cookie-only via `device_session_token` (HttpOnly).
- Do not move guest identity to bearer tokens or localStorage.
- Guest joins/uploads are gated by event status (`active` required).

### Frontend data-access boundary

- Frontend apps must not query the database directly for business data.
- Frontend apps must call backend APIs for all domain/business operations.
- Exception: organizer auth/session bootstrap with Supabase Auth client is allowed.
- Outside auth bootstrap, do not use Supabase DB/storage clients directly in frontend code.

### Contract and errors

- Use stable machine-readable error codes.
- Keep response envelope shape consistent with existing `ErrorResponse`.
- For new endpoints, add OpenAPI path + schemas in the same change.

## 5. Data and Lifecycle Rules

- Events use `event_date` + `end_date` only for status calculations.
- Status windows:
  - Open up to 13 hours before `event_date` starts (UTC)
  - Close up to 13 hours after `end_date` ends (UTC)
- Cron cadence:
  - Event status sync: `00:00` and `12:00` UTC
  - Data cleanup: `01:00` UTC
- Internal cron endpoints:
  - `POST /api/internal/event-status-sync`
  - `POST /api/internal/data-cleanup`
  - Keep `/api/internal/media-retention-cleanup` as backward-compatible alias if already present.

## 6. Storage Rules (R2)

- Use storage helper in `apps/api/src/lib/storage.ts`; do not call Supabase Storage APIs directly.
- Path conventions:
  - Originals: `{event_id}/{media_id}.{ext}`
  - Thumbs: `{event_id}/{media_id}.jpg`
  - Archives: job-scoped paths
- Signed URL TTL is controlled by env (`SIGNED_URL_TTL_SECONDS`).

## 7. Frontend and UX Rules

- Follow Material Design style with clean, responsive, reusable, atomic components.
- Organizer and guest apps are separate web apps.
- Both apps are mobile-first by design.
- Full-screen media preview should show original image URL, not thumbnail URL.
- Keep frontend logic presentation-focused (rendering, local UI/form state, optimistic UI state).
- Do not implement business rules in frontend (pricing, authorization, quotas, lifecycle/status decisions, file-policy validation).

## 8. Coding Style and Change Scope

- Prefer focused, minimal diffs.
- Reuse existing modules/components before adding new ones.
- Keep controllers thin; business logic belongs in services.
- Keep business/domain logic in backend services, not frontend components/hooks.
- Preserve established API shapes unless explicitly changing contract.
- For schema or endpoint changes, include migration/spec/doc updates in same PR/commit scope.
- For non-schema behavior changes, still update impacted docs in `docs/**` as part of the same change.

## 9. Security and Secrets

- Never commit real credentials/tokens.
- Keep `.env.local` values out of code and docs.
- Prefer allowlisted origins + explicit auth checks over implicit trust.

## 10. Validation Checklist for Meaningful Changes

Run relevant checks before finalizing:

- `npm run ci:check`
- `npm run db:check` (for DB-impacting changes)
- App-specific typecheck/build where relevant

If checks are skipped or blocked, state that explicitly.

## 11. Current Known Gaps (Do Not Misrepresent)

- Payment webhook logic is scaffolded and not fully implemented.
- ZIP worker pipeline is partially simulated; full archive generation pipeline is pending.
- Mobile organizer app is scaffolded but not fully implemented.
