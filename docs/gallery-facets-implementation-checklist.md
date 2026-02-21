# Gallery Facets Implementation Checklist

Last updated: 2026-02-18

## Scope

Pre-populate organizer gallery filter options from event-wide data:
- uploader names
- tags
- file type
- download status

Load facets asynchronously so gallery rendering is not blocked.

## Confirmed Decisions

- [x] Use backend-driven facets (no frontend business logic for option generation).
- [x] Facets should cover all media in the event (not only currently loaded page).
- [x] Filter options should support searchable list behavior.
- [x] Search should query API for matches.
- [x] Facet list page limit should be 500 (instead of 200).
- [x] Gallery load should not wait for facets.
- [x] All other previously discussed performance + cleanup points are accepted.
- [x] Facet cleanup + sync/reconciliation must run inside existing daily `pov-data-cleanup-0100` cron (no separate cron jobs).

## Implementation Checklist

### 1) Database + Performance Foundation
- [x] Add `event_uploader_facets` table with `(event_id, uploader_name, media_count, updated_at)`.
- [x] Add `event_tag_facets` table with `(event_id, tag, media_count, updated_at)`.
- [x] Add uniqueness constraints and indexes optimized for `event_id + count/order + search`.
- [x] Add migration rollback safety and idempotent creation guards.

### 2) Backend Facet Maintenance
- [x] Add service helpers to increment/decrement uploader and tag facet counts.
- [x] Update upload-complete flow to write facet counts transactionally.
- [x] Update media cleanup/delete paths to decrement and purge zero-count facet rows.
- [x] Ensure hide/unhide behavior is explicitly handled per product rule (counted vs excluded).

### 3) Facets API
- [x] Add `GET /api/organizer/events/:id/gallery/facets`.
- [x] Support query params for search (`q`) and paging (`limit`, optional cursor/offset).
- [x] Return uploader facets, tag facets, and file type options in one payload.
- [x] Enforce max `limit=500`.
- [x] Add request validation and typed response contracts.

### 4) Organizer API Client
- [x] Add typed facets request/response in `packages/api-client`.
- [x] Add organizer client method for gallery facets endpoint.

### 5) Organizer Frontend (Async Loading + Searchable Select)
- [x] Fetch gallery items and facets in parallel on page load.
- [x] Keep gallery paint independent of facets loading state.
- [x] In filter dialog, replace free-text-only fields with searchable select lists backed by API calls.
- [x] Keep fallback manual input behavior if facet fetch fails.
- [x] Preserve current filter behavior for file type and download status.

### 6) Reconciliation + Cleanup
- [x] Add facet reconciliation step to existing daily `data-cleanup` execution path (`01:00 UTC`) to rebuild/repair facet counts for drift correction.
- [x] Add facet cleanup step to existing daily `data-cleanup` execution path to remove zero/invalid/orphaned facet rows.
- [x] Keep a single daily cleanup cron schedule; do not introduce a separate facets cron.
- [x] Ensure event purge/archive cleanup paths leave no orphan facet records.

### 7) Docs + Spec + Verification
- [x] Update OpenAPI spec with facets endpoint and query params.
- [x] Update `docs/organizer-flow-doc.md` with facet loading/search behavior.
- [x] Update `docs/api-architecture-doc.md` with performance/caching notes.
- [x] Add implementation status entry in `docs/implementation-status.md`.
- [~] Run typecheck/tests for touched workspaces and record results.

## Progress Log

- [x] 2026-02-18: Tracking checklist created and scoped with accepted decisions.
- [x] 2026-02-18: Confirmed facet cleanup + sync will be integrated into existing daily `pov-data-cleanup-0100` cron.
- [x] 2026-02-18: Implemented facet tables, API, async organizer filter loading, and daily cleanup integration.
- [~] 2026-02-18: Verification run completed: `npm run ci:check` passed; `npm run db:check` blocked in local env because `psql` is not installed.
