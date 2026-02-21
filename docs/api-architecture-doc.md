# POV Cam — API Architecture (Server + Client)

## 1. Purpose

Define a production-oriented API architecture for POV Cam that supports:

- Guest upload flows over cookie session auth
- Organizer management flows over API session cookie auth (with bearer fallback)
- Direct-to-storage upload/download using signed URLs
- A typed API client layer shared by web apps

This document is implementation-focused for a Node.js/TypeScript backend.

---

## 2. Core Decisions

### 2.1 Runtime

- **Backend language/runtime:** Node.js + TypeScript
- **HTTP framework:** Express (stay consistent with current design)
- **Architecture style:** Modular monolith with clear domain boundaries

### 2.2 API Contract

- **Source of truth:** OpenAPI spec (`openapi/poveventcam.yaml`)
- **Request/response validation:** Zod schemas in code, aligned with OpenAPI
- **Client generation:** Typed clients generated from OpenAPI for guest and organizer apps

### 2.3 Client Strategy

- **Shared package:** `packages/api-client`
- **Two consumers:** guest web app and organizer web app
- **Two auth modes:** cookie-based (`credentials: include`) and bearer token

---

## 3. System Boundaries

### 3.1 Backend API Responsibilities

- Authentication and authorization
- Event/session/media metadata operations
- Quota and policy enforcement
- Signed URL generation
- Billing orchestration and webhook handling
- Job orchestration and status APIs

### 3.2 Backend API Non-Responsibilities

- Serving file binary payloads
- Rendering UI
- Permanent file transformation on request path

---

## 4. Logical Modules

The API is organized as modules with explicit ownership.

### 4.1 Guest Module

- `POST /api/lookup-event`
- `POST /api/join`
- `GET /api/my-session`
- `PATCH /api/my-session`
- `POST /api/create-upload`
- `POST /api/complete-upload`
- `GET /api/my-uploads`

### 4.2 Organizer Module

- `POST /api/organizer/auth/session`
- `GET /api/organizer/auth/session`
- `DELETE /api/organizer/auth/session`
- Event CRUD/lifecycle endpoints
- Gallery, moderation, downloads
- Guest management
- Capacity/billing update endpoints

### 4.3 Auth Module

- Guest cookie auth middleware
- Organizer session-cookie middleware with Supabase bearer fallback
- CSRF origin/referer checks for organizer session mutations
- Shared authorization checks (event ownership/collaboration)

### 4.4 Media Module

- Upload reservation
- Completion verification against storage metadata
- Signed URL generation
- Media visibility status transitions (`uploaded`, `hidden`, etc.)

### 4.5 Billing Module

- Fee calculation
- Payment session creation
- Webhook idempotency and reconciliation

### 4.6 Jobs Module

- Orphan cleanup orchestration
- Thumbnail fallback trigger
- ZIP generation trigger/status
- Event expiry/archival/purge jobs

---

## 5. Codebase Structure

Recommended backend folder layout:

```text
apps/api/
  src/
    app.ts
    server.ts
    config/
      env.ts
      constants.ts
    middleware/
      cors.ts
      rate-limit.ts
      request-id.ts
      auth-guest.ts
      auth-organizer.ts
      error-handler.ts
    modules/
      guest/
        guest.routes.ts
        guest.controller.ts
        guest.service.ts
        guest.repo.ts
        guest.schema.ts
      organizer/
        organizer.routes.ts
        organizer.controller.ts
        organizer.service.ts
        organizer.repo.ts
        organizer.schema.ts
      media/
      billing/
      jobs/
    shared/
      db/
        client.ts
        tx.ts
      storage/
        storage.client.ts
      cache/
        event-config-cache.ts
      observability/
        logger.ts
        metrics.ts
      errors/
        app-error.ts
        error-codes.ts
```

---

## 6. Layering Rules

### 6.1 Allowed Dependencies

- Routes -> Controller -> Service -> Repo/External Adapter
- Service can call multiple repos/adapters and own transaction boundaries
- Repo layer has no HTTP concerns

### 6.2 Disallowed Dependencies

- Controller directly querying DB
- Repo importing Express request/response types
- Business logic in middleware

---

## 7. API Client Architecture

### 7.1 Package Layout

```text
packages/api-client/
  src/
    core/
      http.ts
      errors.ts
      retry.ts
      types.ts
    guest/
      client.ts
    organizer/
      client.ts
    generated/
      schema.ts
      operations.ts
```

### 7.2 HTTP Core

The shared HTTP wrapper should provide:

- Base URL handling
- Request timeout with `AbortController`
- Structured error mapping
- Request ID propagation (`x-request-id`)
- Safe retry policy for idempotent reads only

### 7.3 Auth Modes

- Guest client:
  - Uses `credentials: 'include'`
  - Never reads auth cookie in JavaScript
- Organizer client:
  - Web app uses `credentials: 'include'` with API session cookie
  - Session cookie is created by `POST /api/organizer/auth/session` using a Supabase bearer token
  - Non-browser clients can keep using `Authorization: Bearer <token>`

### 7.4 Client API Shape

Prefer operation-centric methods over raw fetch wrappers.

```ts
guestApi.joinEvent(input)
guestApi.createUpload(input)
guestApi.completeUpload(input)
organizerApi.createEvent(input)
organizerApi.updateEvent(input)
organizerApi.getGallery(input)
```

---

## 8. Request Lifecycle (Server)

Standard middleware order:

1. Request ID
2. CORS
3. Cookie parser
4. Body parser with payload size limits
5. Rate limit middleware
6. Auth middleware (route-scoped)
7. Validation middleware (schema-scoped)
8. Controller -> service -> repo
9. Centralized error handler

---

## 9. AuthN/AuthZ Model

### 9.1 Guest

- Session token in `HttpOnly` cookie
- DB stores token hash only
- Every guest endpoint resolves and validates device session
- Session must be active and event must allow requested action

### 9.2 Organizer

- Organizer API endpoints accept either:
  - `organizer_session_token` cookie (preferred for web), or
  - Supabase bearer token (fallback/integration use cases)
- Session cookie lifecycle:
  - Create: `POST /api/organizer/auth/session`
  - Read: `GET /api/organizer/auth/session`
  - Revoke: `DELETE /api/organizer/auth/session`
- Event-level authorization via `event_organizers`
- Owner/collaborator role gates enforced in service layer

---

## 10. Consistent Error Contract

All non-2xx responses return:

```json
{
  "error": {
    "code": "UPLOAD_LIMIT_REACHED",
    "message": "You have reached your upload limit.",
    "request_id": "req_123",
    "details": {}
  }
}
```

Rules:

- `code` is stable and machine-readable
- `message` is human-readable and safe to display
- `details` is optional and never leaks internals/secrets

---

## 11. Idempotency and Retries

### 11.1 Server-Side Idempotency

Use `Idempotency-Key` for mutation endpoints with payment or long-running side effects:

- `POST /api/organizer/events`
- `PATCH /api/organizer/events/:id` when payment can be initiated
- `POST /api/organizer/events/:id/download-all`

Store dedupe keys with response snapshot for 24 hours.

### 11.2 Client Retry Policy

- Retry `GET` on transient 5xx/timeouts with capped exponential backoff
- Do not auto-retry non-idempotent `POST` unless idempotency key is used
- Guest upload queue handles retry at workflow layer, not generic HTTP layer

---

## 12. Data Access and Transactions

### 12.1 Repository Rules

- One repository per aggregate/table group
- SQL kept near repository methods
- Prefer explicit query functions over generic ORM magic

### 12.2 Transaction Rules

Use DB transactions for:

- Event create + owner mapping insert
- Capacity changes + fee updates
- State transitions that must be atomic across multiple rows

Avoid long transactions around external calls. Persist intent first, then execute external side effect.

### 12.3 Gallery Facet Tables

Organizer gallery filter options (uploader/tag) are served from precomputed facet tables:

- `event_uploader_facets`
- `event_tag_facets`

Write-path updates happen during upload completion and cleanup transitions, while the daily `data-cleanup` job performs reconciliation to correct drift. This keeps organizer filter-option reads fast and decoupled from raw `media` scans.

---

## 13. Storage Interaction Contract

### 13.1 Create Upload

- Validate requested MIME/type policy by mode
- Reserve media row with `pending`
- Persist extension-aware `storage_path`
- Return signed upload URLs

### 13.2 Complete Upload

- Verify row ownership and `pending` state
- Verify object exists in storage and metadata is sane
- Mark row as `uploaded`
- Trigger thumbnail fallback async

---

## 14. Caching and Rate Limiting

### 14.1 Cache

- Event config cache keyed by `event_id`
- TTL: 60 seconds
- Invalidate on event updates/lifecycle transitions and capacity changes

### 14.2 Rate Limits

- Keep existing policy from backend architecture doc
- Abstract limiter store interface to swap in Redis without route changes

---

## 15. Observability

### 15.1 Logging

- Structured JSON logs
- Include `request_id`, `event_id`, `session_id`, `organizer_id`, `media_id` when available
- Log all mutation endpoints and background jobs

### 15.2 Metrics

- Endpoint latency by route and status
- Error rate by `error.code`
- `create-upload` and `complete-upload` success/failure ratio
- Pending -> uploaded -> expired funnel

### 15.3 Tracing

- Propagate `request_id` to downstream logs and client errors
- Add trace spans for DB and storage operations in Stage 2+

---

## 16. Testing Strategy

### 16.1 Unit Tests

- Service logic (quota checks, fee calc, authz rules)
- Error mapping and policy helpers

### 16.2 Integration Tests

- Route -> DB behavior for guest and organizer critical paths
- Auth middleware behavior
- Webhook idempotency

### 16.3 Contract Tests

- Validate implementation against OpenAPI
- Generate client and run smoke tests on generated methods

### 16.4 Load Tests

- Focus on `POST /api/create-upload` and `POST /api/complete-upload`
- Verify latency and correctness under concurrent guest traffic

---

## 17. Rollout Plan

1. Define OpenAPI for existing endpoints.
2. Create `packages/api-client` with generated types + thin wrapper.
3. Refactor backend into module/layer boundaries without behavior change.
4. Add centralized error contract and request IDs.
5. Add idempotency for billing/download-all mutations.
6. Add integration + load tests for upload hot path.
7. Move jobs to separate worker when traffic requires.

---

## 18. Future Evolution

- Migrate from in-process jobs to BullMQ worker
- Introduce Redis for distributed rate limiting and shared cache
- Optional polyglot workers (for RAW/ZIP heavy workloads) while API stays Node
- Add versioned API (`/api/v1`) once external clients are introduced
