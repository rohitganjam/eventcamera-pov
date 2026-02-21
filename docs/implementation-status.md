# POV EventCamera Implementation Status

Last updated: 2026-02-18

This document tracks what is implemented vs what is pending.

## Completed

### Product and architecture docs
- [x] Guest flow documentation (`docs/guest-flow-doc.md`)
- [x] Organizer flow documentation (`docs/organizer-flow-doc.md`)
- [x] Backend architecture documentation (`docs/backend-architecture-doc.md`)
- [x] API architecture documentation (`docs/api-architecture-doc.md`)
- [x] Design guidelines documentation (`docs/design-guidelines.md`)
- [x] OpenAPI contract draft (`openapi/poveventcam.yaml`)
- [x] Vercel hosting guide (`docs/vercel-hosting-guide.md`)
- [x] Supabase cron setup guide (`docs/supabase-cron-setup.md`)
- [x] Share modal implementation checklist (`docs/share-modal-implementation-checklist.md`)

### Monorepo and workspace setup
- [x] Monorepo workspace structure (`apps/*`, `packages/*`)
- [x] Shared root scripts for development/checks (`package.json`)
- [x] TypeScript workspace baseline (`tsconfig.base.json`)

### API foundation
- [x] Express bootstrap and middleware chain (`apps/api/src/app.ts`)
- [x] Request ID, not-found, and error handling middleware
- [x] CORS policy supporting localhost, `*.vercel.app`, and allowlist origins
- [x] Route registration for guest/organizer/webhooks/internal modules
- [x] Health endpoint (`GET /api/health`)
- [x] Vercel serverless adapter path normalizer (`apps/api/api/[...path].ts`)

### Database and Supabase auth foundation
- [x] Environment config + validation (`apps/api/src/config/env.ts`)
- [x] Postgres connection + transaction helpers (`apps/api/src/lib/db.ts`)
- [x] Supabase access-token verification helper (`apps/api/src/lib/supabase.ts`)
- [x] SQL migrations:
- [x] `0001_init.sql`
- [x] `0002_media_uploader_tags.sql`
- [x] `0003_download_selected.sql`
- [x] `0004_event_end_date.sql`
- [x] `0005_event_status_cron.sql`
- [x] `0006_media_retention_cron.sql`
- [x] `0007_organizer_sessions.sql`
- [x] `0008_gallery_facets.sql`
- [x] DB setup/check scripts (`apps/api/scripts/db/setup.sh`, `apps/api/scripts/db/check.sh`)
- [x] API workspace scripts wired (`db:setup`, `db:check`)

### Storage migration (Cloudflare R2)
- [x] Cloudflare R2 env vars integrated in API config
- [x] R2 storage helper implemented via AWS SDK (`apps/api/src/lib/storage.ts`)
- [x] Signed download URL generation from R2
- [x] Signed upload URL generation from R2
- [x] Object existence checks from R2 (`HeadObject`)
- [x] Object delete helper for storage lifecycle
- [x] Guest and organizer services moved to storage helper (no storage ops in `supabase.ts`)

### Event lifecycle cron
- [x] Event lifecycle based on `event_date` + `end_date`
- [x] Open/close buffers set to 13 hours (open early, close late)
- [x] In-process cron scheduler runs at 00:00 and 12:00 UTC (`apps/api/src/cron/event-status-cron.ts`)
- [x] Internal protected trigger endpoint (`POST /api/internal/event-status-sync`)
- [x] Daily media retention cleanup cron at 01:00 UTC (`apps/api/src/cron/media-retention-cron.ts`)
- [x] Internal protected data cleanup endpoint (`POST /api/internal/data-cleanup`)
- [x] Enable/disable cron via env (`ENABLE_CRON_JOBS`)

### Organizer backend
- [x] Organizer auth middleware with session-cookie + bearer fallback (`apps/api/src/middleware/organizer-auth.ts`)
- [x] Organizer API session lifecycle endpoints (`POST/GET/DELETE /api/organizer/auth/session`)
- [x] Organizer session storage + TTL migration (`0007_organizer_sessions.sql`)
- [x] Organizer session CSRF origin/referer guard (`apps/api/src/middleware/organizer-session-csrf.ts`)
- [x] Organizer service implemented against DB (`apps/api/src/modules/organizer/organizer.service.ts`)
- [x] Events create/list/get/patch
- [x] Event close/archive
- [x] Capacity update API with payment redirect response shape
- [x] Gallery list with pagination (`cursor`, `limit`) and sort (`newest`/`oldest`)
- [x] Gallery filters (uploader, tags, date, session)
- [x] Gallery facets endpoint for searchable filter options (`GET /events/:id/gallery/facets`)
- [x] Gallery stats endpoint
- [x] Hide/unhide/bulk-hide media
- [x] Single media download URL endpoint
- [x] Batch media download URL endpoint (`POST /events/:id/media/download-urls`)
- [x] Download-all job create + poll APIs
- [x] Download-selected job create + poll APIs
- [x] Guest list + deactivate guest

### Guest backend
- [x] Guest controller/service fully implemented against DB (`apps/api/src/modules/guest/*`)
- [x] `POST /api/lookup-event` (event info before registration)
- [x] `POST /api/join`
- [x] `GET /api/my-session`
- [x] `PATCH /api/my-session`
- [x] `POST /api/create-upload`
- [x] `POST /api/complete-upload`
- [x] `GET /api/my-uploads`
- [x] Cookie-backed session token issuance and hashing
- [x] Join/upload gated by event status (active required)
- [x] Quota enforcement (guest count + uploads per guest)
- [x] File type/size enforcement by compression mode (`compressed` vs `raw`)
- [x] Per-file uploader name and tags persisted on media rows
- [x] Upload finalization verifies object existence in storage

### API client packages
- [x] Core typed HTTP client + error envelope support (`packages/api-client/src/core/*`)
- [x] Organizer API client is implemented and used by organizer web app (`packages/api-client/src/organizer/*`)
- [x] Organizer client includes batch media download URL support

### Organizer web app
- [x] Next.js organizer app scaffold (`apps/web-organizer`)
- [x] Supabase auth flows: password sign-in + sign-up (email verification)
- [x] API session-cookie bootstrap from Supabase bearer token (`AuthProvider`)
- [x] Auth provider/gate (`AuthProvider`, `OrganizerApp`, `OrganizerGalleryApp`)
- [x] Shared organizer header component for dashboard and gallery (`OrganizerHeader`)
- [x] Dashboard event list + create-event modal (`OrganizerShell`)
- [x] Event actions on dashboard: gallery navigation, share modal, close, archive
- [x] Guest share modal with QR shown by default and inline copy action
- [x] Organizer gallery page (`/events/:id/gallery`) implemented
- [x] Gallery pagination behavior:
- [x] Initial load of 30 items
- [x] Eager load remainder of current 100-item page on scroll
- [x] Prev/next page controls
- [x] Gallery filters by uploader and tags
- [x] "Show not yet downloaded" filter
- [x] Async gallery facet option loading (non-blocking for initial gallery paint)
- [x] Searchable facet filter UI for uploader and tags (API-backed)
- [x] Selection model:
- [x] Select/deselect individual items
- [x] Select all current page (loads remaining page items first)
- [x] Selection resets when page/data changes
- [x] Client-side download selected flow:
- [x] Fetches batch presigned URLs from API
- [x] Downloads with concurrency pool
- [x] Creates browser ZIP and triggers download
- [x] Progress indicator + downloaded badge tracking
- [x] Full-screen media preview uses original image URL
- [x] Preview header pinned at top with metadata and actions

### Guest web app
- [x] Next.js guest app scaffold (`apps/web-guest`)
- [x] Mobile-first join flow
- [x] Event lookup landing screen (event details shown before join)
- [x] Join form with required name and conditional PIN
- [x] Cookie-backed session after join
- [x] Name tag edit/save flow
- [x] File selection with local preview generation before upload
- [x] Upload queue with per-file tags and remove action
- [x] Tag-input component (`apps/web-guest/src/components/tag-input.tsx`)
- [x] Upload-all flow (individual upload buttons removed)
- [x] Queue cleanup when uploads complete (clears fully after all success)
- [x] My uploads gallery with uploader + tags
- [x] Full-screen preview in guest app matches organizer style and uses original image URL

### Repository checks
- [x] `npm run ci:check` passes on current codebase (2026-02-15)

## Partially Completed

### Download archive pipeline
- [~] Download-all and download-selected job APIs exist.
- [~] Job status polling exists.
- [~] Job completion is currently simulated in service code (materialized URLs), not real archive generation.
- [ ] Real ZIP generation, storage upload, and archive cleanup pipeline are still pending.

### Payment flow
- [~] Payment redirect response contract exists in organizer APIs.
- [ ] Real payment provider integration and webhook reconciliation are not implemented.

### API clients
- [~] Organizer client is productionized.
- [~] Guest client file exists (`packages/api-client/src/guest/client.ts`) but is still scaffold-level and not exported from `packages/api-client/src/index.ts`.

### Mobile organizer app
- [~] Workspace/app scaffold exists (`apps/mobile-organizer`).
- [ ] Real mobile app implementation is not started (current scripts are placeholder echoes).

### Testing depth
- [~] Workspace typechecks pass.
- [ ] API integration tests, webhook tests, and end-to-end flow tests are still pending.

## Pending Implementation

### Webhooks
- [ ] Implement `POST /api/webhooks/payment` logic (currently not implemented)
- [ ] Add signature verification and webhook idempotency
- [ ] Apply payment state transitions in DB

### Background jobs and async workflows
- [ ] Implement real worker/service for heavy jobs (ZIP generation, retention, cleanup)
- [ ] Add retry/backoff and monitoring for background jobs

### Organizer frontend completeness
- [ ] Guest management UI in organizer web
- [ ] Capacity edit + payment redirect UX in organizer web
- [ ] Event detail management page UX beyond current dashboard + gallery
- [ ] Native/app-level invite sharing actions (Web Share API, WhatsApp, email) from share modal

### Guest frontend hardening
- [ ] Offline queue with IndexedDB + retry/backoff
- [ ] More robust upload retry UX and richer progress states
- [ ] Optional client-side compression/conversion parity by event mode

### Security and operations
- [ ] Add formal authorization boundary tests
- [ ] Define/apply RLS policies where needed
- [ ] Add request throttling/rate limiting
- [ ] Add structured metrics/alerts and runbooks

## Recent Changes (2026-02-15)

- Switched storage implementation from Supabase Storage APIs to Cloudflare R2 helper (`apps/api/src/lib/storage.ts`).
- Added organizer API session-cookie auth with bearer fallback and CSRF guard.
- Added event lifecycle sync cron behavior for 00:00 and 12:00 UTC with 13-hour open/close buffers.
- Added protected internal cron trigger endpoint and documented Supabase pg_cron setup.
- Added daily generic data cleanup cron trigger (`/api/internal/data-cleanup`) with backward-compatible alias.
- Added organizer batch media download URL API and wired organizer gallery to client-side selected-download ZIP flow.
- Updated organizer UI with shared header, refreshed dashboard cards, and QR-based share modal.
- Updated guest upload UX with local preview queue, tag input component, upload-all flow, queue purge behavior, and full-screen original-image preview.
- Synced OpenAPI and architecture docs with current auth model, internal routes, and storage backend.
- Added gallery facet tables + API-backed searchable facet options and integrated facet reconciliation into daily `data-cleanup` cron.
