# POV Cam — Guest Flow & Experience

## 1. Overview

Guests are unauthenticated users who interact with POV Cam through a mobile browser. They scan a QR code at an event, upload photos, and view their own uploads. There is no login, no app install, and no OTP. Identity is tied to a device session cookie.

## 1.1 Design Mandate

All guest UI implementations must follow these non-optional guidelines:

- Follow Material Design guidelines.
- Keep UI clean, consistent, and accessible.
- Build responsive components that work across mobile, tablet, and desktop.
- Reuse existing components where possible before creating new ones.
- Components must be atomic and composable (build larger UI from smaller reusable units).

---

## 2. Identity Model

### How a Guest is Identified

A guest is identified by a single `HttpOnly` secure cookie containing a `device_session_token`. This cookie is set on the first visit when the guest joins an event.

- **Cookie:** `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`. Use a host-only cookie on `guest.eventpovcamera.app` (do not set `Domain=.eventpovcamera.app`). This is the **only** identity mechanism. It is sent automatically with every API request. JavaScript cannot read or modify it.
- **localStorage:** Stores supplementary, non-authoritative data only — display name, event name (for fast UI rendering before API responds), local thumbnail cache references, upload queue state. All guest keys must be namespaced (for example, `guest:*`). All of this is derived data.
- **Session validation:** On every app load, the client calls `GET /api/my-session`. If the server returns 401 (cookie missing or invalid), the client clears only guest-scoped localStorage keys (for example, `guest:*`) and redirects to the join flow.
- **Cookie loss:** If a guest clears their browser data, they lose their session and appear as a new guest. This is acceptable for the short-lived nature of event usage.

> [!NOTE]
> Do not clear entire domain localStorage. Guest and organizer apps may share the same origin, and a full clear can remove organizer state.

### What a Device Session Stores

| Field          | Type      | Purpose                              |
| -------------- | --------- | ------------------------------------ |
| id             | uuid      | Internal identifier                  |
| event_id       | uuid      | Which event this session belongs to  |
| token_hash     | text      | Hashed version of the session token  |
| display_name   | text      | Optional name the guest provides     |
| is_active      | boolean   | Can be deactivated by organizer      |
| created_at     | timestamp | When the session was created         |
| last_active_at | timestamp | Updated on each API interaction      |

The session does **not** store an `uploads_count`. The authoritative upload count is always derived from:

```sql
SELECT COUNT(*) FROM media
WHERE device_session_id = ? AND status IN ('pending', 'uploaded')
```

---

## 3. Guest Journey — Step by Step

### Step 1: Scan QR Code

The organizer displays a QR code at the event venue. The QR encodes a URL:

```
https://guest.eventpovcamera.app/e/{event_slug}
```

The guest scans with their phone camera. The URL opens in the default mobile browser. No app install required.

### Step 2: Join Event

The web app loads and detects no existing session cookie for this event.

**First visit flow:**

1. The app calls `POST /api/lookup-event` with the event slug to fetch event details.
2. The landing page displays:
   - Event name (prominently displayed)
   - Event date (formatted nicely)
   - Name input field (required)
   - PIN input field (only if `requires_pin` is true)
   - "Join Event" button
3. The guest enters their name (required) and PIN (if needed).
4. The guest clicks "Join Event" to register.
5. The client calls `POST /api/join` with the event slug, display name, and optional PIN.

**Lookup Event endpoint:**

```
POST /api/lookup-event
Body: { event_slug: "rohit-jyoti-wedding" }
```

Response:
```json
{
  "id": "uuid",
  "slug": "rohit-jyoti-wedding",
  "name": "Rohit & Jyoti's Wedding",
  "status": "active",
  "requires_pin": true,
  "end_date": "2026-02-15",
  "expires_at": "2026-02-16T12:59:59.999Z",
  "event_date": "2026-02-14"
}
```

This endpoint does NOT create a session or set any cookies. It only returns public event information so the landing page can be rendered.

**What the server does:**

1. Validates the event slug exists and the event status is `active`.
2. If PIN is enabled, validates the PIN against the stored hash.
3. Performs an **atomic guest count check and reservation**:

```sql
WITH guest_check AS (
  SELECT COUNT(*) as current_count
  FROM device_sessions
  WHERE event_id = $1 AND is_active = true
)
INSERT INTO device_sessions (id, event_id, token_hash, display_name, is_active)
SELECT gen_random_uuid(), $1, $2, $3, true
FROM guest_check
WHERE guest_check.current_count < $4  -- $4 = max_guests
RETURNING id;
```

If the insert returns no rows → event is full → return `EVENT_FULL`.

5. Generates a `device_session_token` (cryptographically random, e.g., 32 bytes hex).
6. Stores the hash of the token in `device_sessions.token_hash`.
7. Sets the token as an `HttpOnly` cookie in the response.
8. Returns event metadata (name, upload limit, current upload count = 0).

**Returning visit flow:**

If the cookie already exists and is valid, the app calls `GET /api/my-session`, receives session info and event metadata, and goes straight to the main screen.

### Step 3: Main Screen

The guest sees:

- **Event name** at the top.
- **Upload counter:** "3 / 15 uploaded" (fetched from server, not localStorage).
- **Name tag section:**
  - Displays the guest's name as text
  - Edit button (pencil icon) to switch to edit mode
  - In edit mode: input field with Save and Cancel buttons
  - Name is saved via `PATCH /api/my-session`
- **"Take Photo" button** — opens the device camera.
- **"Upload from Gallery" button** — opens the device photo picker.
- **Upload queue in the same upload section** — when files are selected, the queue appears directly below the add/upload controls (not as a separate card).
- **"My Uploads" section** — grid of thumbnails of previously uploaded photos.

### Step 4: Capture or Select Media

When the guest taps "Take Photo" or "Upload from Gallery":

1. The browser's native camera/file picker opens.
2. The guest captures or selects one or more images.
3. For each selected file, the app generates a local preview using a Blob URL.

### Step 5: Preview Before Upload

For each selected file:

1. The app shows a full-screen preview.
2. Two buttons: **Upload** and **Cancel**.
3. If Cancel → file is discarded locally, nothing happens.
4. If Upload → proceed to Step 6.

### Step 6: Upload Process

This is the most critical flow. It involves three API calls and one direct storage upload.

**6a. Create Upload (Reserve Quota Slot)**

```
POST /api/create-upload
Cookie: device_session_token (sent automatically)
Body: { file_type: "image/jpeg", file_size: 2340000, tags: ["dance-floor", "family-table-3"] }
```

The server:

1. Validates the session cookie.
2. Validates the event status is active (date-window logic is handled by status reconciliation jobs).
3. Validates file type is allowed and file size is within limits.
4. Runs an **atomic quota check and reservation** (per-guest limit):

```sql
WITH quota_check AS (
  SELECT COUNT(*) as current_count
  FROM media
  WHERE device_session_id = $1
    AND status IN ('pending', 'uploaded')
)
INSERT INTO media (
  id, event_id, device_session_id, status, mime_type, size_bytes,
  storage_path, thumb_path, uploader_name, tags
)
SELECT $2, $3, $1, 'pending', $4, $5,
       CONCAT($3, '/', $2, '.', $6),   -- event_id/media_id.ext (e.g., .jpg, .png)
       CONCAT($3, '/', $2, '.jpg'),    -- thumbs are always .jpg
       $8,                              -- display_name snapshot used for organizer filtering
       $9::text[]                       -- optional per-file tags from guest
FROM quota_check
WHERE quota_check.current_count < $7   -- $7 = event.max_uploads_per_guest
RETURNING id;
```

> [!NOTE]
> The `media_id` ($2) is generated in the application layer via `crypto.randomUUID()` before this query runs. This allows constructing the storage paths atomically within the insert.

If the insert returns no rows → guest quota reached → return `403 UPLOAD_LIMIT_REACHED`.

5. Derives the original file extension from validated `file_type` (for example: `.jpg`, `.png`, `.webp`, `.cr2`) and generates a signed upload URL for `/originals/{event_id}/{media_id}.{ext}`.
6. Optionally generates a signed upload URL for `/thumbs/{event_id}/{media_id}.jpg`.

Response:

```json
{
  "media_id": "uuid",
  "upload_url": "https://project.supabase.co/storage/v1/...",
  "thumb_upload_url": "https://project.supabase.co/storage/v1/...",
  "remaining_uploads": 12,
  "compression_mode": "compressed",
  "max_file_size": 5000000
}
```

The `compression_mode` tells the client whether to compress (`compressed`) or upload originals (`raw`). The `max_file_size` varies accordingly.

**6b. Client-Side Compression**

Compression behavior depends on `compression_mode` from the `create-upload` response:

**If `compression_mode === 'compressed'` (default):**

- Convert uploads to JPEG before sending to storage.
- Limit long side (width or height) to 4000px.
- JPEG quality: 0.8 (80%).
- For HEIC/HEIF inputs, attempt conversion with `heic-to` first.
- If HEIC conversion fails on the client, upload the original file as a fallback.
- Uses `<canvas>` for resize + re-encode.
- Also generates a thumbnail (400px wide, JPEG quality 0.6) for the `thumb_upload_url`.

**If `compression_mode === 'raw'` (uncompressed enabled):**

- **JPEG/PNG/WebP/HEIC:** Upload original file. Validate size against `max_file_size` (15MB).
- **RAW (CR2, NEF, ARW):**
    - Validate size (up to 25MB allowed).
    - Upload original file to `originals/`.
    - **Thumbnail:** Client cannot generate. Upload a static "processing" placeholder image to `thumbs/`. Server job will extract real thumbnail later.

```javascript
/* Pseudocode */
async function prepareUpload(file, config) {
  if (config.compression_mode === 'raw') {
    // Raw mode: skip client-side conversion/compression.
    return file;
  }

  // Standard mode:
  // 1) Decode image
  // 2) Resize so long side <= 4000px
  // 3) Encode JPEG at quality 0.8
  return await convertToJpegWithResize(file, {
    maxLongSide: 4000,
    quality: 0.8
  });
}
```
```

The server validates `file_size` at `create-upload` and rejects files exceeding the limit for the event's compression mode.

**6c. Direct Upload to Cloudflare R2**

The client uploads the compressed file directly to the signed URL. The file goes from the guest's phone straight to Cloudflare R2 (S3-compatible). The API server never handles the file binary.

```javascript
await fetch(upload_url, {
  method: 'PUT',
  headers: { 'Content-Type': uploadFile.type },
  body: uploadFile
});
```

If a thumbnail was generated, it's uploaded to `thumb_upload_url` in parallel.

**6d. Complete Upload**

```
POST /api/complete-upload
Cookie: device_session_token
Body: { media_id: "uuid" }
```

The server:

1. Validates the session owns this media row.
2. Performs a storage metadata check for `storage_path` (object exists, size > 0, and content type/extension matches the reserved media row).
3. If verification passes, marks `media.status = 'uploaded'`.
4. Updates `media.uploaded_at` to now.
5. Queues a thumbnail check job (does the thumb exist in storage? If not, flag for server-side generation).

### Step 7: Upload Queue & Offline Handling

The client uses **IndexedDB** to manage an upload queue for reliability:

- When the guest selects multiple photos, each is added to the queue.
- The queue processor picks items one at a time (or 2-3 concurrent).
- If a network request fails, the item stays in the queue with a retry count.
- On app reload, the queue is resumed.
- Items in the queue have states: `queued`, `uploading`, `complete`, `failed`.

**Multi-tab handling:** Use the Web Locks API to ensure only one tab processes the queue:

```javascript
await navigator.locks.request('upload-queue-processor', async () => {
  // Only one tab holds this lock at a time
  while (true) {
    const item = await getNextQueueItem();
    if (!item) { await sleep(1000); continue; }
    await processUpload(item);
  }
});
```

Fallback for browsers without Web Locks: use BroadcastChannel to elect a leader tab.

This ensures that uploads survive brief network drops, which are common at wedding venues.

### Step 8: "My Uploads" View

The guest can view all photos they've uploaded to this event.

```
GET /api/my-uploads
Cookie: device_session_token
```

Returns:

```json
{
  "uploads": [
    {
      "media_id": "uuid",
      "thumb_url": "https://...signed-download-url...",
      "uploader_name": "Amit",
      "tags": ["dance-floor", "cousins"],
      "status": "uploaded",
      "uploaded_at": "2026-02-08T14:30:00Z"
    }
  ],
  "total_uploaded": 7,
  "max_uploads": 15
}
```

The `thumb_url` is a **signed download URL** generated by the server on each request (short-lived, e.g., 1 hour expiry). The client never gets permanent URLs to storage.

---

## 4. Guest Restrictions

- **Cannot delete** any uploaded media. There is no delete API endpoint for guests. Signed URLs are upload-only or download-only — never delete.
- **Cannot see other guests' uploads.** The `my-uploads` endpoint only returns media belonging to the current session.
- **Cannot modify event settings.**
- **Cannot exceed upload limit.** Enforced server-side atomically at `create-upload`.
- **Cannot upload after event closes.** The `create-upload` endpoint checks only `event.status`.

---

## 5. Edge Cases & Error Handling

| Scenario                               | Behavior                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Guest clears browser data              | New session created on next visit. Old uploads are orphaned from guest's view but still exist in event gallery for organizer. |
| Guest opens incognito tab              | Treated as a new guest. Counts toward `max_guests` limit.                |
| Guest hits upload limit                | `create-upload` returns 403. UI shows "You've reached your upload limit (15/15)." |
| Event is full (max guests reached)     | `POST /api/join` returns 403. UI shows "This event has reached its guest limit." |
| Event is closed/expired                | All upload endpoints return 403. UI shows "This event is no longer accepting uploads." |
| Upload fails mid-transfer              | Item stays in IndexedDB queue. Retried automatically. `pending` media row cleaned up by background job after 30 minutes if never completed. |
| Multiple concurrent uploads            | Each `create-upload` atomically reserves a quota slot. If 3 slots remain and 5 concurrent requests fire, only 3 succeed. |
| PIN is wrong                           | `POST /api/join` returns 401. Guest can retry.                          |
| Session deactivated by organizer       | All API calls return 403. UI shows "Your session has been deactivated. Contact the event organizer." |
| Network drops during upload            | IndexedDB queue retries. Signed URL valid for 2 hours. If expired, client calls `create-upload` again for a fresh URL. |

---

## 6. File Handling Summary

| Property              | Compressed Mode (default)     | Raw Mode (Premium only)       |
| --------------------- | ----------------------------- | ----------------------------- |
| Allowed types (MVP)   | image/jpeg, image/png, image/webp | image/jpeg, image/png, image/webp, image/heic, RAW families (CR2/NEF/ARW/DNG/ORF/RW2) |
| Max file size         | 5 MB (post-compression target enforced by server policy) | 15 MB for JPEG/PNG/WebP/HEIC; 25 MB for RAW |
| Client compression    | Required. Long side <= 4000px, JPEG 0.8 (with JPEG conversion) | None — original uploaded      |
| Thumbnail generation  | Client-side: 400px wide, JPEG 0.6 | JPEG/PNG/WebP/HEIC: client-side thumbnail; RAW: placeholder thumbnail uploaded, server replaces asynchronously |
| Storage path (original)| `/originals/{event_id}/{media_id}.{ext}` | `/originals/{event_id}/{media_id}.{ext}` |
| Storage path (thumb)  | `/thumbs/{event_id}/{media_id}.jpg` | `/thumbs/{event_id}/{media_id}.jpg` |

**Common to both modes:**

| Property               | Value                        |
| ---------------------- | ---------------------------- |
| Bucket access          | Private. All access via signed URLs. |
| Signed upload URL TTL  | 2 hours (Supabase default)   |
| Signed download URL TTL| 1 hour (configurable)        |
