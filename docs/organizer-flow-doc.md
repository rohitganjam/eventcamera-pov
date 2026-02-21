# POV Cam — Organizer Flow & Experience

## 1. Overview

Organizers are authenticated users who create events, manage settings, view uploaded photos, and handle billing. They interact through a separate web application (or a separate section of the same app) that requires login. Organizers never upload photos — they consume and manage content uploaded by guests.

## 1.1 Design Mandate

All organizer UI implementations must follow these non-optional guidelines:

- Follow Material Design guidelines.
- Keep UI clean, consistent, and accessible.
- Build responsive components that work across mobile, tablet, and desktop.
- Reuse existing components where possible before creating new ones.
- Components must be atomic and composable (build larger UI from smaller reusable units).

---

## 2. Identity & Authentication

### Auth Provider

Supabase Auth handles all organizer authentication. Supported methods:

- Email + password
- Email verification during sign-up (via confirmation email)

On successful login, Supabase issues a JWT (access token + refresh token). The organizer web app exchanges that bearer token for an API session cookie via `POST /api/organizer/auth/session`, and then calls organizer APIs with `credentials: include`. API endpoints still accept bearer tokens as a fallback for non-browser clients.

### Organizer Schema

**organizers**

| Field      | Type      | Notes                                |
| ---------- | --------- | ------------------------------------ |
| id         | uuid      | Same as Supabase Auth user ID        |
| email      | text      | From auth provider                   |
| name       | text      | Display name                         |
| created_at | timestamp | Account creation time                |

**event_organizers** (supports multiple organizers per event in the future)

| Field        | Type      | Notes                                |
| ------------ | --------- | ------------------------------------ |
| event_id     | uuid      | FK to events                         |
| organizer_id | uuid      | FK to organizers                     |
| role         | enum      | `owner` or `collaborator`            |
| created_at   | timestamp |                                      |

For MVP, each event has a single owner. The `event_organizers` table is included now to avoid a schema migration later when collaboration is added.

> [!NOTE]
> Collaborator functionality is post-MVP. No endpoints exist yet to add/remove collaborators.

---

## 3. Organizer Journey — Step by Step

### Step 1: Sign Up / Login

**New organizer:**

1. Opens the organizer app (e.g., `eventpovcamera.app`).
2. Signs up with email + password.
3. Supabase Auth creates the auth user.
4. A trigger or post-signup hook creates the corresponding `organizers` row.
5. Organizer is redirected to the dashboard.

**Returning organizer:**

1. Opens the organizer app.
2. Logs in via email/password.
3. Supabase JWT is stored in the browser (managed by Supabase Auth client SDK).
4. Web app calls `POST /api/organizer/auth/session` to set `organizer_session_token` cookie.
5. Redirected to the dashboard.

**Session management:**

- Supabase access tokens are short-lived (default: 1 hour) and refreshed by the Supabase client SDK.
- API cookie session TTL is controlled by `ORGANIZER_SESSION_TTL_DAYS` (default: 7 days).
- Organizer API session cookie is HttpOnly and scoped to `/api/organizer`.
- Logging out clears the API session cookie and signs out from Supabase.

### Step 2: Dashboard

After login, the organizer sees:

- **List of their events** with summary stats (total uploads, guest count, status).
- **"Create New Event" button.**
- **Account settings** (name, email, password change).

### Step 3: Create Event

The organizer fills out a form:

| Field             | Required | Default | Notes                                            |
| ----------------- | -------- | ------- | ------------------------------------------------ |
| Event name        | Yes      | —       | e.g., "Rohit & Jyoti's Wedding"                 |
| Event date        | Yes      | —       | Event start date (UTC)                           |
| End date          | No       | Event date | Event end date (UTC, defaults to same day)   |
| Max guests        | Yes      | 100     | Number of guests (free tier: 100)               |
| Images per guest  | Yes      | 10      | Upload limit per guest (free tier: 10)          |
| Uncompressed      | No       | Off     | Enable raw uploads (additional fee)             |
| PIN               | No       | —       | Optional 4-digit PIN for access control          |
| Cover image       | No       | —       | Optional branding image                          |

**Pricing (calculated live as organizer adjusts settings):**

| Component | Free Tier | Additional Cost |
|-----------|-----------|-----------------|
| Guests | First 100 | +₹200 per 100 guests |
| Images/guest | First 10 | +₹100 per 10 images, per 100 guests |
| Uncompressed | — | +₹1 per image capacity |

Example: 200 guests, 20 images/guest, compressed = ₹400

**What the server does on `POST /api/organizer/events`:**

1. Validates organizer auth (session cookie or bearer token) and identifies the organizer.
2. Generates a unique `slug` for the event.
3. Calculates the total fee based on guests, images/guest, and compression mode.
4. If fee > 0:
   - Initiates payment via payment provider
   - Returns payment URL; event creation completes after payment webhook
5. If fee = 0 (within free tier, compressed):
   - Creates event immediately
6. If a PIN is provided, hashes it before storing.
7. Sets `event_date` (start date) and `end_date` (defaults to same day unless specified).
8. Status is derived with a UTC buffer:
   - opens 13 hours before `event_date` starts
   - closes 13 hours after `end_date` ends
9. A cron running every 12 hours at `00:00 UTC` and `12:00 UTC` reconciles event statuses (`draft/active/closed`).
10. Creates the event row with `total_fee` and `currency`.
11. Creates an `event_organizers` row with `role = 'owner'`.
12. Returns the event details including the guest URL: `https://guest.eventpovcamera.app/e/{slug}`.

### Step 4: QR Code Generation

The organizer app generates a QR code client-side from the guest URL:

```
https://guest.eventpovcamera.app/e/{slug}
```

Using a library like `qrcode.react` or `qrcode-generator`. No QR image is stored server-side.

The organizer can:

- Download the QR as a PNG/SVG for printing.
- Copy the link to share via WhatsApp, email, etc.
- View a preview of what guests will see.

### Step 5: Event Management

From the event detail page, the organizer can:

**Update event settings:**

```
PATCH /api/organizer/events/:id
Body: { name?, pin?, max_guests?, max_uploads_per_guest?, compression_mode? }
```

**Before event opens (`now() < event_date@00:00Z - 13h`):**
- All fields are editable
- Changing guests, images/guest, or compression mode recalculates the fee
- If new fee > paid fee → initiate payment for difference
- If new fee < paid fee → credit is stored for future use (no refunds)

**After event starts:**
- Only `name` and `pin` are editable
- `max_guests`, `max_uploads_per_guest`, and `compression_mode` are locked

```javascript
// In PATCH handler
const isLocked = Date.now() >= (Date.parse(`${event.event_date}T00:00:00Z`) - 13 * 60 * 60 * 1000);

if (isLocked && (body.max_guests || body.max_uploads_per_guest || body.compression_mode)) {
  return res.status(403).json({ 
    error: 'EVENT_SETTINGS_LOCKED',
    message: 'Capacity and compression settings cannot be changed after the event has started'
  });
}

// Recalculate fee if settings changed
if (!isLocked && (body.max_guests || body.max_uploads_per_guest || body.compression_mode)) {
  const newFee = calculateEventFee(
    body.max_guests ?? event.max_guests,
    body.max_uploads_per_guest ?? event.max_uploads_per_guest,
    body.compression_mode === 'raw' || (event.compression_mode === 'raw' && body.compression_mode !== 'compressed')
  );
  const feeDiff = newFee - event.total_fee;
  if (feeDiff > 0) {
    return initiatePayment(eventId, feeDiff);
  }
}
```

**Close event (stop accepting uploads):**

```
POST /api/organizer/events/:id/close
```

Sets `event.status = 'closed'`. All guest upload endpoints will return 403. Existing uploads remain accessible. Guests can still view their "My Uploads" but cannot add new ones.

**Archive event:**

```
POST /api/organizer/events/:id/archive
```

Sets `event.status = 'archived'`. Guest access is fully disabled. The organizer can still view the gallery and download files. After a configurable retention period, archived events move to `purged`.

**Event lifecycle states:**

```
draft → active → closed → archived → purged
```

| Status   | Guest can upload | Guest can view | Organizer can view | Storage retained |
| -------- | ---------------- | -------------- | ------------------- | ---------------- |
| draft    | No               | No             | Yes                 | Yes              |
| active   | Yes              | Yes            | Yes                 | Yes              |
| closed   | No               | Yes            | Yes                 | Yes              |
| archived | No               | No             | Yes                 | Grace period     |
| purged   | No               | No             | Limited metadata only | No             |

### Step 6: Event Gallery

The gallery is the organizer's primary view of all uploaded media for an event.
In the current web implementation, this opens on a dedicated page:

```
/events/{event_id}/gallery
```

```
GET /api/organizer/events/:id/gallery
Query: { cursor?, limit?, sort?, sort_by?, sort_order?, filter_date?, filter_session?, filter_uploader?, filter_tag?, filter_file_type? }
```

`filter_uploader` and `filter_tag` are comma-separated multi-select filters with OR semantics:
- uploader filter: media matches if uploader is any selected name
- tag filter: media matches if any selected tag exists on the media item
- between filter groups (uploader/tag/file type/date/session), matching is AND

For pre-populated filter options, the organizer app calls a separate facets endpoint:

```
GET /api/organizer/events/:id/gallery/facets
Query: { uploader_q?, tag_q?, limit? }   // limit max: 500
```

This loads when the filter popup opens and is cached while the gallery page is open. The cache refreshes when the organizer uses the gallery refresh action or reopens the gallery page.

**Pagination:** Cursor-based (not offset-based). Each response includes a `next_cursor` if more results exist. This performs well even with thousands of images.

**Response:**

```json
{
  "media": [
    {
      "media_id": "uuid",
      "thumb_url": "https://...signed-download-url...",
      "uploaded_by": "Amit" | null,
      "uploaded_at": "2026-02-08T14:30:00Z",
      "status": "uploaded",
      "size_bytes": 2340000,
      "mime_type": "image/jpeg",
      "tags": ["dance-floor", "cousins"]
    }
  ],
  "next_cursor": "abc123",
  "total_count": 487
}
```

**Gallery features:**

- Thumbnail grid view with lazy loading.
- Click to view full-size image (fetches a signed download URL for the original on demand).
- Filter by upload date, guest session, uploader name, and tags.
- Sort by newest first (default) or oldest first.
- "uploaded_by" shows the guest's `display_name` if they provided one.
- "tags" are file-level labels submitted by guests during upload.

**Gallery stats:**

```
GET /api/organizer/events/:id/gallery/stats
```

Returns: total uploaded count, total storage used (bytes), uploads per day breakdown, unique guest count.

### Step 7: Media Moderation

Organizers can hide inappropriate or unwanted photos. Hidden photos are removed from the organizer gallery by default and are excluded from bulk downloads, but are not permanently deleted.

**Hide a single photo:**

```
POST /api/organizer/events/:id/media/:media_id/hide
```

Sets `media.status = 'hidden'`.

**Unhide:**

```
POST /api/organizer/events/:id/media/:media_id/unhide
```

Sets `media.status = 'uploaded'`.

**Bulk hide:**

```
POST /api/organizer/events/:id/media/bulk-hide
Body: { media_ids: ["uuid1", "uuid2", ...] }
```

Permanent deletion is a **prohibited action** for now. Only the background purge job deletes files, and only for archived/expired events.

### Step 8: Downloads

**Single photo download:**

```
GET /api/organizer/events/:id/media/:media_id/download-url
```

Returns a signed download URL for the original file (not the thumbnail). URL is short-lived (e.g., 15 minutes). The organizer's browser downloads the file directly from Cloudflare R2.

**Bulk download (all photos):**

```
POST /api/organizer/events/:id/download-all
Body: { exclude_hidden: true }
```

This triggers an **asynchronous ZIP generation job** because zipping hundreds of photos takes time.

Response:

```json
{
  "job_id": "uuid",
  "status": "processing",
  "estimated_time_seconds": 120
}
```

The organizer polls the job status:

```
GET /api/organizer/jobs/:job_id
```

When complete:

```json
{
  "job_id": "uuid",
  "status": "complete",
  "download_url": "https://...signed-url...",
  "file_size_bytes": 524288000,
  "expires_at": "2026-02-08T16:00:00Z"
}
```

The ZIP is stored temporarily in a dedicated storage bucket and cleaned up after the signed URL expires.

**ZIP job limits:**

| Parameter | Value | Notes |
|-----------|-------|-------|
| Max files per ZIP | 1,000 | Split into multiple ZIPs if exceeded |
| Max ZIP size | 2 GB | Split if cumulative original size exceeds |
| Job timeout | 10 minutes | Fails with partial completion if exceeded |

For large events exceeding these limits, the job creates multiple ZIPs and returns multiple download URLs in the status response.

### Step 9: Guest Management

Organizers can view and manage guest sessions.

**List guests:**

```
GET /api/organizer/events/:id/guests
```

Returns:

```json
{
  "guests": [
    {
      "session_id": "uuid",
      "display_name": "Amit" | null,
      "upload_count": 12,
      "is_active": true,
      "created_at": "2026-02-08T10:00:00Z",
      "last_active_at": "2026-02-08T14:30:00Z"
    }
  ],
  "total_guests": 87,
  "max_guests": 200
}
```

**Deactivate a guest session:**

```
POST /api/organizer/events/:id/guests/:session_id/deactivate
```

Sets `device_sessions.is_active = false`. The guest's cookie becomes invalid — all API calls will return 403. Their uploaded photos remain in the gallery.

Use cases: removing a misbehaving guest, revoking access for someone who shouldn't have joined.

### Step 10: Capacity Management

Capacity (guests and images/guest) is managed via the event settings.

**Increase Capacity:**

1. Organizer updates settings via `PATCH /api/organizer/events/:id`.
2. Server calculates the difference in fee.
3. If additional payment is required, returns a payment URL.
4. Organizer completes payment.
5. Webhook updates the event capacity.

Increases take effect immediately upon payment success. Guests who were previously at their limit can now upload more.

**Decrease Capacity:**

1. Organizer updates settings via `PATCH /api/organizer/events/:id`.
2. Server calculates the fee difference (negative).
3. Fees are not refunded but stored as credit for this event (if re-increased later).
4. Updates take effect immediately.

---

## 4. Organizer Permissions Summary

| Action                        | Owner | Collaborator (future) |
| ----------------------------- | ----- | --------------------- |
| Create event                  | ✅    | ❌                    |
| Edit event settings           | ✅    | ✅                    |
| Close / archive event         | ✅    | ❌                    |
| Delete event                  | ✅    | ❌                    |
| View gallery                  | ✅    | ✅                    |
| Hide / unhide media           | ✅    | ✅                    |
| Download single / bulk        | ✅    | ✅                    |
| View guest list               | ✅    | ✅                    |
| Deactivate guest              | ✅    | ✅                    |
| Manage Capacity (Billing)     | ✅    | ❌                    |
| Add/remove collaborators      | ✅    | ❌                    |

---

## 5. Email Notifications

Notifications are sent via a transactional email service (Resend, Postmark, or SendGrid). MVP uses HTTP API calls:

```javascript
await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
  body: JSON.stringify({
    from: 'POV EventCamera <noreply@eventpovcamera.app>',
    to: organizer.email,
    subject: 'Your event photos will be deleted soon',
    html: emailTemplate,
  }),
});
```

**Notification triggers:**
- 7 days before storage purge (archived events)
- Event expiry reminder
- Payment confirmation/failure

---

## 6. Edge Cases & Error Handling

| Scenario                                   | Behavior                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Organizer creates event with duplicate slug| Server generates a unique slug. If collision detected, appends random suffix. |
| Payment webhook arrives before redirect    | Webhook is idempotent. Processes regardless of client state.  |
| Payment fails after initiation             | Event creation fails. Organizer sees "payment failed" and can retry. |
| Organizer tries to close an already closed event | Idempotent. Returns success with current status.                    |
| Bulk download of 2000+ photos              | ZIP job splits into multiple ZIPs (max 1,000 files each). Returns multiple download URLs. |
| Event expires while guests are uploading   | In-flight uploads with signed URL can complete (URL valid for 2h). New `create-upload` calls are rejected. |
| Organizer deactivates a guest mid-upload   | The `complete-upload` call will fail (session invalid). `pending` media cleaned up by orphan job. |
| Organizer changes settings after event starts | Rejected with `EVENT_SETTINGS_LOCKED`. Only name and PIN are editable after start. |
| Organizer increases capacity before start  | Fee difference calculated and payment initiated. Event updated after payment success. |
| Organizer decreases capacity before start  | Fee credit stored (no refunds). Event updated immediately. |
| Organizer enables uncompressed before start | Uncompressed fee calculated and added to total. Payment initiated for difference. |
