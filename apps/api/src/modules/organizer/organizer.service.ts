import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { env } from '../../config/env';
import { query, withTransaction } from '../../lib/db';
import { createSignedStorageObjectUrl } from '../../lib/storage';
import { AppError } from '../../shared/errors/app-error';

import { EventStatus } from '../../shared/types/event-status';

type CompressionMode = 'compressed' | 'raw';
// EventStatus type removed, imported from shared
type MediaStatus = 'uploaded' | 'hidden' | 'pending' | 'failed' | 'expired';
type JobStatus = 'queued' | 'processing' | 'complete' | 'failed';

interface CreateEventInput {
  name: string;
  event_date: string;
  end_date?: string;
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode?: CompressionMode;
  pin?: string | null;
  cover_image_path?: string | null;
  currency?: string;
}

interface PatchEventInput {
  name?: string;
  pin?: string | null;
  max_guests?: number;
  max_uploads_per_guest?: number;
  compression_mode?: CompressionMode;
}

interface CapacityUpdateInput {
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode?: CompressionMode;
}

interface GalleryQueryInput {
  cursor?: string;
  limit?: number;
  sort?: 'newest' | 'oldest';
  filter_date?: string;
  filter_session?: string;
  filter_uploader?: string;
  filter_tag?: string;
}

interface DbEventRow {
  id: string;
  name: string;
  slug: string;
  status: EventStatus;
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode: CompressionMode;
  total_fee: number;
  currency: string;
  event_date: Date | string;
  end_date: Date | string;
  pin_hash: string | null;
  cover_image_path: string | null;
  created_at: Date | string;
  total_uploads?: number;
  guest_count?: number;
  total_storage_bytes?: number | string;
  unique_guest_count?: number;
}

interface DbMediaGalleryRow {
  media_id: string;
  uploaded_at: Date | string | null;
  uploaded_by: string | null;
  status: MediaStatus;
  size_bytes: number;
  mime_type: string;
  thumb_path: string | null;
  storage_path: string | null;
  tags: string[] | null;
}

interface DbMediaDownloadRow {
  media_id: string;
  storage_path: string | null;
  uploaded_at: Date | string | null;
  uploader_name: string | null;
}

interface DbMediaStatsRow {
  uploaded_at: Date | string | null;
  size_bytes: number;
  device_session_id: string | null;
}

interface DbJobRow {
  id: string;
  event_id: string;
  organizer_id: string;
  status: JobStatus;
  exclude_hidden: boolean;
  media_ids: string[] | null;
  download_url: string | null;
  download_urls: string[] | null;
  file_size_bytes: number | null;
  expires_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
}

interface PaymentRedirectResponse {
  requires_payment: true;
  payment_url: string;
  payment_reference: string;
  fee_difference: number;
  currency: string;
}

const DEFAULT_CURRENCY = 'INR';
const DEFAULT_COMPRESSION_MODE: CompressionMode = 'compressed';
const MAX_EVENT_SLUG_LENGTH = 32;
const OPEN_EARLY_BUFFER_HOURS = 13;
const CLOSE_LATE_BUFFER_HOURS = 13;
const ZIP_SPLIT_FILE_COUNT = 1_000;
const ZIP_SPLIT_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ensureUuid(value: string, fieldName: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a valid UUID`, {
      field: fieldName
    });
  }

  return value;
}

function ensureNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} is required`, { field: fieldName });
  }

  return value.trim();
}

function ensurePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a positive integer`, {
      field: fieldName
    });
  }

  return value;
}

function ensureDateString(value: unknown, fieldName: string): string {
  const text = ensureNonEmptyString(value, fieldName);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a valid date (YYYY-MM-DD)`, {
      field: fieldName
    });
  }

  return text;
}

function ensureOptionalShortString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a string`, {
      field: fieldName
    });
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length > maxLength) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be at most ${maxLength} characters`,
      { field: fieldName }
    );
  }

  return normalized;
}

function parseTagFilter(value: unknown): string[] {
  const source = ensureOptionalShortString(value, 'filter_tag', 200);
  if (!source) return [];

  const tags = source
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(tags)].slice(0, 8);
}

function ensureCompressionMode(value: unknown, fieldName: string): CompressionMode {
  if (value === 'compressed' || value === 'raw') {
    return value;
  }

  throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be either compression or raw`, {
    field: fieldName
  });
}

function hashPin(pin: string): string {
  return createHash('sha256').update(pin).digest('hex');
}

function slugify(value: string, maxLength = MAX_EVENT_SLUG_LENGTH): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '');
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toISOString();
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function eventOpenAtMs(eventDate: string): number {
  return Date.parse(`${eventDate}T00:00:00.000Z`) - OPEN_EARLY_BUFFER_HOURS * 60 * 60 * 1000;
}

function eventCloseAtMs(endDate: string): number {
  return Date.parse(`${endDate}T23:59:59.999Z`) + CLOSE_LATE_BUFFER_HOURS * 60 * 60 * 1000;
}

function toEventCloseIso(endDate: string): string {
  return new Date(eventCloseAtMs(endDate)).toISOString();
}

function resolveEventStatus(eventDate: string, endDate: string): EventStatus {
  const now = Date.now();
  if (now < eventOpenAtMs(eventDate)) return EventStatus.DRAFT;
  if (now > eventCloseAtMs(endDate)) return EventStatus.CLOSED;
  return EventStatus.ACTIVE;
}

function buildGuestUrl(slug: string): string {
  return `${env.guestWebBaseUrl}/e/${slug}`;
}

function buildArchiveDownloadUrl(eventId: string, jobId: string, part?: number): string {
  const partPath = part ? `part-${part}.zip` : 'all.zip';
  return `https://downloads.eventpovcamera.app/events/${eventId}/archives/${jobId}/${partPath}?token=${randomUUID()}`;
}

function parseCursor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'cursor must be a non-negative integer');
  }
  return parsed;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', 'limit must be between 1 and 200');
  }
  return value;
}

function sanitizeFileNamePart(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function extensionFromPath(storagePath: string): string {
  const fileName = storagePath.split('/').pop() ?? '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return 'jpg';
  }

  return fileName.slice(dotIndex + 1).toLowerCase();
}

function compactTimestamp(value: Date | string | null): string {
  const iso = toIsoDateTime(value) ?? new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildDownloadFileName(row: DbMediaDownloadRow): string {
  const extension = row.storage_path ? extensionFromPath(row.storage_path) : 'jpg';
  const uploaderPart = sanitizeFileNamePart(row.uploader_name, 'guest');
  const timestampPart = compactTimestamp(row.uploaded_at);
  const shortId = row.media_id.slice(0, 8);
  return `${timestampPart}-${uploaderPart}-${shortId}.${extension}`;
}

function calculateTotalFeeMinor(
  maxGuests: number,
  maxUploadsPerGuest: number,
  compressionMode: CompressionMode
): number {
  const guestBlocks = Math.ceil(maxGuests / 100);
  const extraGuestBlocks = Math.max(0, guestBlocks - 1);
  const extraUploadBlocks = Math.ceil(Math.max(0, maxUploadsPerGuest - 10) / 10);

  const guestCostMajor = extraGuestBlocks * 200;
  const uploadCostMajor = extraUploadBlocks * guestBlocks * 100;
  const rawCostMajor = compressionMode === 'raw' ? maxGuests * maxUploadsPerGuest : 0;

  return (guestCostMajor + uploadCostMajor + rawCostMajor) * 100;
}

async function queryOwnedEventBase(
  organizerId: string,
  eventId: string
): Promise<DbEventRow> {
  const result = await query<DbEventRow>(
    `
      SELECT
        e.id,
        e.name,
        e.slug,
        e.status,
        e.max_guests,
        e.max_uploads_per_guest,
        e.compression_mode,
        e.total_fee,
        e.currency,
        e.event_date,
        e.end_date,
        e.pin_hash,
        e.cover_image_path,
        e.created_at
      FROM events e
      INNER JOIN event_organizers eo ON eo.event_id = e.id
      WHERE eo.organizer_id = $1::uuid
        AND e.id = $2::uuid
      LIMIT 1
    `,
    [organizerId, eventId]
  );

  const event = result.rows[0];
  if (!event) {
    throw new AppError(404, 'NOT_FOUND', 'Event not found');
  }

  return event;
}

async function queryOwnedEventDetail(
  organizerId: string,
  eventId: string
): Promise<DbEventRow> {
  const result = await query<DbEventRow>(
    `
      SELECT
        e.id,
        e.name,
        e.slug,
        e.status,
        e.max_guests,
        e.max_uploads_per_guest,
        e.compression_mode,
        e.total_fee,
        e.currency,
        e.event_date,
        e.end_date,
        e.pin_hash,
        e.cover_image_path,
        e.created_at,
        COALESCE(ms.total_uploads, 0)::int AS total_uploads,
        COALESCE(gs.guest_count, 0)::int AS guest_count,
        COALESCE(ms.total_storage_bytes, 0)::bigint AS total_storage_bytes,
        COALESCE(ms.unique_guest_count, 0)::int AS unique_guest_count
      FROM events e
      INNER JOIN event_organizers eo ON eo.event_id = e.id
      LEFT JOIN (
        SELECT
          event_id,
          COUNT(*)::int AS total_uploads,
          COALESCE(SUM(size_bytes), 0)::bigint AS total_storage_bytes,
          COUNT(DISTINCT device_session_id)::int AS unique_guest_count
        FROM media
        WHERE status IN ('uploaded', 'hidden')
        GROUP BY event_id
      ) ms ON ms.event_id = e.id
      LEFT JOIN (
        SELECT event_id, COUNT(*)::int AS guest_count
        FROM device_sessions
        GROUP BY event_id
      ) gs ON gs.event_id = e.id
      WHERE eo.organizer_id = $1::uuid
        AND e.id = $2::uuid
      LIMIT 1
    `,
    [organizerId, eventId]
  );

  const event = result.rows[0];
  if (!event) {
    throw new AppError(404, 'NOT_FOUND', 'Event not found');
  }

  return event;
}

function eventSettingsLocked(event: DbEventRow): boolean {
  const eventDate = toIsoDate(event.event_date);
  return Date.now() >= eventOpenAtMs(eventDate);
}

async function generateUniqueSlug(name: string, client: PoolClient): Promise<string> {
  const base = slugify(name) || slugify(`event-${randomUUID().slice(0, 8)}`);
  let counter = 0;

  // Keep probing until a free slug is found.
  for (; ;) {
    const suffix = counter > 0 ? `-${counter}` : '';
    const maxBaseLength = Math.max(0, MAX_EVENT_SLUG_LENGTH - suffix.length);
    const basePart = slugify(base, maxBaseLength);
    const fallbackPart = maxBaseLength > 0 ? 'event'.slice(0, maxBaseLength) : '';
    const candidate = `${basePart || fallbackPart}${suffix}`;

    const existsResult = await client.query<{ id: string }>(
      'SELECT id FROM events WHERE slug = $1 LIMIT 1',
      [candidate]
    );

    if (existsResult.rowCount === 0) {
      return candidate;
    }

    counter += 1;
  }
}

function toEventSummary(event: DbEventRow) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    status: event.status,
    max_guests: event.max_guests,
    max_uploads_per_guest: event.max_uploads_per_guest,
    compression_mode: event.compression_mode,
    total_fee: toNumber(event.total_fee),
    currency: event.currency,
    event_date: toIsoDate(event.event_date),
    end_date: toIsoDate(event.end_date),
    guest_url: buildGuestUrl(event.slug),
    total_uploads: toNumber(event.total_uploads),
    guest_count: toNumber(event.guest_count),
    created_at: toIsoDateTime(event.created_at) ?? new Date().toISOString()
  };
}

function toEventDetail(event: DbEventRow) {
  return {
    ...toEventSummary(event),
    pin_enabled: Boolean(event.pin_hash),
    cover_image_path: event.cover_image_path,
    stats: {
      total_uploads: toNumber(event.total_uploads),
      total_storage_bytes: toNumber(event.total_storage_bytes),
      unique_guest_count: toNumber(event.unique_guest_count)
    }
  };
}

class OrganizerService {
  async createEvent(organizerId: string, input: CreateEventInput) {
    ensureUuid(organizerId, 'organizer_id');

    const name = ensureNonEmptyString(input.name, 'name');
    const eventDate = ensureDateString(input.event_date, 'event_date');
    const endDate =
      input.end_date !== undefined ? ensureDateString(input.end_date, 'end_date') : eventDate;
    if (endDate < eventDate) {
      throw new AppError(400, 'VALIDATION_ERROR', 'end_date must be on or after event_date', {
        field: 'end_date'
      });
    }
    const maxGuests = ensurePositiveInteger(input.max_guests, 'max_guests');
    const maxUploadsPerGuest = ensurePositiveInteger(
      input.max_uploads_per_guest,
      'max_uploads_per_guest'
    );
    const compressionMode = input.compression_mode
      ? ensureCompressionMode(input.compression_mode, 'compression_mode')
      : DEFAULT_COMPRESSION_MODE;

    if (input.pin !== undefined && input.pin !== null) {
      if (typeof input.pin !== 'string' || !/^\d{4}$/.test(input.pin)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'pin must be a 4-digit string', { field: 'pin' });
      }
    }

    const totalFee = calculateTotalFeeMinor(maxGuests, maxUploadsPerGuest, compressionMode);
    const currency = input.currency?.trim() || DEFAULT_CURRENCY;

    if (totalFee > 0) {
      return this.paymentRedirect(totalFee, currency);
    }

    const created = await withTransaction(async (client) => {
      const slug = await generateUniqueSlug(name, client);
      const status = resolveEventStatus(eventDate, endDate);
      const expiresAt = toEventCloseIso(endDate);

      const eventInsert = await client.query<DbEventRow>(
        `
          INSERT INTO events (
            name,
            slug,
            status,
            max_guests,
            max_uploads_per_guest,
            compression_mode,
            total_fee,
            currency,
            event_date,
            end_date,
            expires_at,
            pin_hash,
            cover_image_path
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::date,
            $10::date,
            $11::timestamptz,
            $12,
            $13
          )
          RETURNING
            id,
            name,
            slug,
            status,
            max_guests,
            max_uploads_per_guest,
            compression_mode,
            total_fee,
            currency,
            event_date,
            end_date,
            pin_hash,
            cover_image_path,
            created_at
        `,
        [
          name,
          slug,
          status,
          maxGuests,
          maxUploadsPerGuest,
          compressionMode,
          totalFee,
          currency,
          eventDate,
          endDate,
          expiresAt,
          input.pin ? hashPin(input.pin) : null,
          input.cover_image_path ?? null
        ]
      );

      const event = eventInsert.rows[0];
      if (!event) {
        throw new AppError(500, 'DB_WRITE_FAILED', 'Failed to create event');
      }

      await client.query(
        `
          INSERT INTO event_organizers (event_id, organizer_id, role)
          VALUES ($1::uuid, $2::uuid, 'owner')
          ON CONFLICT (event_id, organizer_id) DO NOTHING
        `,
        [event.id, organizerId]
      );

      return event.id;
    });

    const event = await queryOwnedEventDetail(organizerId, created);
    return { event: toEventDetail(event) };
  }

  async listEvents(organizerId: string) {
    ensureUuid(organizerId, 'organizer_id');

    const result = await query<DbEventRow>(
      `
        SELECT
          e.id,
          e.name,
          e.slug,
          e.status,
          e.max_guests,
          e.max_uploads_per_guest,
          e.compression_mode,
          e.total_fee,
          e.currency,
          e.event_date,
          e.end_date,
          e.pin_hash,
          e.cover_image_path,
          e.created_at,
          COALESCE(ms.total_uploads, 0)::int AS total_uploads,
          COALESCE(gs.guest_count, 0)::int AS guest_count
        FROM events e
        INNER JOIN event_organizers eo ON eo.event_id = e.id
        LEFT JOIN (
          SELECT event_id, COUNT(*)::int AS total_uploads
          FROM media
          WHERE status IN ('uploaded', 'hidden')
          GROUP BY event_id
        ) ms ON ms.event_id = e.id
        LEFT JOIN (
          SELECT event_id, COUNT(*)::int AS guest_count
          FROM device_sessions
          GROUP BY event_id
        ) gs ON gs.event_id = e.id
        WHERE eo.organizer_id = $1::uuid
        ORDER BY e.created_at DESC
      `,
      [organizerId]
    );

    return {
      events: result.rows.map((event) => toEventSummary(event))
    };
  }

  async getEvent(organizerId: string, eventId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const event = await queryOwnedEventDetail(organizerId, eventId);
    return { event: toEventDetail(event) };
  }

  async patchEvent(organizerId: string, eventId: string, input: PatchEventInput) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const current = await queryOwnedEventBase(organizerId, eventId);

    const nextName = input.name !== undefined ? ensureNonEmptyString(input.name, 'name') : current.name;
    const capacityTouched =
      input.max_guests !== undefined ||
      input.max_uploads_per_guest !== undefined ||
      input.compression_mode !== undefined;

    if (capacityTouched && eventSettingsLocked(current)) {
      throw new AppError(
        403,
        'EVENT_SETTINGS_LOCKED',
        'Capacity and compression settings cannot be changed after the event has started'
      );
    }

    const nextMaxGuests =
      input.max_guests !== undefined
        ? ensurePositiveInteger(input.max_guests, 'max_guests')
        : current.max_guests;

    const nextMaxUploadsPerGuest =
      input.max_uploads_per_guest !== undefined
        ? ensurePositiveInteger(input.max_uploads_per_guest, 'max_uploads_per_guest')
        : current.max_uploads_per_guest;

    const nextCompressionMode =
      input.compression_mode !== undefined
        ? ensureCompressionMode(input.compression_mode, 'compression_mode')
        : current.compression_mode;

    const nextFee = calculateTotalFeeMinor(nextMaxGuests, nextMaxUploadsPerGuest, nextCompressionMode);
    const feeDifference = nextFee - toNumber(current.total_fee);

    if (capacityTouched && feeDifference > 0) {
      return this.paymentRedirect(feeDifference, current.currency);
    }

    let nextPinHash = current.pin_hash;
    if (input.pin !== undefined) {
      if (input.pin === null || input.pin === '') {
        nextPinHash = null;
      } else {
        if (typeof input.pin !== 'string' || !/^\d{4}$/.test(input.pin)) {
          throw new AppError(400, 'VALIDATION_ERROR', 'pin must be a 4-digit string', {
            field: 'pin'
          });
        }
        nextPinHash = hashPin(input.pin);
      }
    }

    await query(
      `
        UPDATE events
        SET
          name = $1,
          max_guests = $2,
          max_uploads_per_guest = $3,
          compression_mode = $4,
          total_fee = $5,
          pin_hash = $6
        WHERE id = $7::uuid
      `,
      [nextName, nextMaxGuests, nextMaxUploadsPerGuest, nextCompressionMode, nextFee, nextPinHash, eventId]
    );

    const event = await queryOwnedEventDetail(organizerId, eventId);
    return {
      success: true,
      event: toEventDetail(event)
    };
  }

  async closeEvent(organizerId: string, eventId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const current = await queryOwnedEventBase(organizerId, eventId);
    if (current.status === EventStatus.ARCHIVED || current.status === EventStatus.PURGED) {
      throw new AppError(409, 'INVALID_EVENT_STATE', 'Archived or purged events cannot be closed');
    }

    await query('UPDATE events SET status = $1 WHERE id = $2::uuid', [EventStatus.CLOSED, eventId]);
    const event = await queryOwnedEventDetail(organizerId, eventId);

    return {
      success: true,
      event: toEventDetail(event)
    };
  }

  async archiveEvent(organizerId: string, eventId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const current = await queryOwnedEventBase(organizerId, eventId);
    if (current.status === EventStatus.PURGED) {
      throw new AppError(409, 'INVALID_EVENT_STATE', 'Purged events cannot be archived');
    }

    await query('UPDATE events SET status = $1 WHERE id = $2::uuid', [EventStatus.ARCHIVED, eventId]);
    const event = await queryOwnedEventDetail(organizerId, eventId);

    return {
      success: true,
      event: toEventDetail(event)
    };
  }

  async getGallery(organizerId: string, eventId: string, queryInput: GalleryQueryInput) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    await queryOwnedEventBase(organizerId, eventId);

    const offset = parseCursor(queryInput.cursor);
    const limit = parseLimit(queryInput.limit);

    const whereParts: string[] = ['m.event_id = $1::uuid'];
    const whereParams: unknown[] = [eventId];

    if (queryInput.filter_date) {
      ensureDateString(queryInput.filter_date, 'filter_date');
      whereParams.push(queryInput.filter_date);
      whereParts.push(`DATE(COALESCE(m.uploaded_at, m.created_at)) = $${whereParams.length}::date`);
    }

    if (queryInput.filter_session) {
      ensureUuid(queryInput.filter_session, 'filter_session');
      whereParams.push(queryInput.filter_session);
      whereParts.push(`m.device_session_id = $${whereParams.length}::uuid`);
    }

    const uploaderFilter = ensureOptionalShortString(
      queryInput.filter_uploader,
      'filter_uploader',
      120
    );
    if (uploaderFilter) {
      whereParams.push(`%${uploaderFilter.toLowerCase()}%`);
      whereParts.push(
        `LOWER(COALESCE(m.uploader_name, ds.display_name, '')) LIKE $${whereParams.length}`
      );
    }

    const tagFilter = parseTagFilter(queryInput.filter_tag);
    if (tagFilter.length > 0) {
      whereParams.push(tagFilter);
      whereParts.push(`m.tags @> $${whereParams.length}::text[]`);
    }

    const whereSql = whereParts.join(' AND ');
    const sort = queryInput.sort === 'oldest' ? 'ASC' : 'DESC';
    const fromSql = 'FROM media m LEFT JOIN device_sessions ds ON ds.id = m.device_session_id';

    const countResult = await query<{ total_count: number }>(
      `SELECT COUNT(*)::int AS total_count ${fromSql} WHERE ${whereSql}`,
      whereParams
    );
    const totalCount = countResult.rows[0]?.total_count ?? 0;

    const pagedParams = [...whereParams, limit, offset];
    const limitParam = `$${pagedParams.length - 1}`;
    const offsetParam = `$${pagedParams.length}`;

    const pageResult = await query<DbMediaGalleryRow>(
      `
        SELECT
          m.id AS media_id,
          COALESCE(m.uploaded_at, m.created_at) AS uploaded_at,
          COALESCE(m.uploader_name, ds.display_name) AS uploaded_by,
          m.status,
          m.size_bytes,
          m.mime_type,
          m.thumb_path,
          m.storage_path,
          m.tags
        ${fromSql}
        WHERE ${whereSql}
        ORDER BY COALESCE(m.uploaded_at, m.created_at) ${sort}
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
      `,
      pagedParams
    );

    const media = await Promise.all(
      pageResult.rows.map(async (item) => {
        const thumbPath = item.thumb_path ?? item.storage_path;
        const bucket = item.thumb_path ? env.storageThumbsBucket : env.storageOriginalsBucket;

        const thumbUrl = thumbPath
          ? await createSignedStorageObjectUrl(bucket, thumbPath)
          : `${env.guestWebBaseUrl}/e/${eventId}/missing-thumb`;
        const originalUrl = item.storage_path
          ? await createSignedStorageObjectUrl(env.storageOriginalsBucket, item.storage_path)
          : thumbUrl;

        return {
          media_id: item.media_id,
          thumb_url: thumbUrl,
          original_url: originalUrl,
          uploaded_by: item.uploaded_by,
          uploaded_at: toIsoDateTime(item.uploaded_at) ?? new Date().toISOString(),
          status: item.status,
          size_bytes: item.size_bytes,
          mime_type: item.mime_type,
          tags: item.tags ?? []
        };
      })
    );

    const nextCursor = offset + limit < totalCount ? String(offset + limit) : null;

    return {
      media,
      next_cursor: nextCursor,
      total_count: totalCount
    };
  }

  async getGalleryStats(organizerId: string, eventId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    await queryOwnedEventBase(organizerId, eventId);

    const result = await query<DbMediaStatsRow>(
      `
        SELECT
          COALESCE(uploaded_at, created_at) AS uploaded_at,
          size_bytes,
          device_session_id
        FROM media
        WHERE event_id = $1::uuid
          AND status IN ('uploaded', 'hidden')
      `,
      [eventId]
    );

    const uploadsPerDay = new Map<string, number>();
    let totalStorageBytes = 0;
    const uniqueGuests = new Set<string>();

    for (const row of result.rows) {
      const uploadedAt = toIsoDateTime(row.uploaded_at);
      if (uploadedAt) {
        const day = uploadedAt.slice(0, 10);
        uploadsPerDay.set(day, (uploadsPerDay.get(day) ?? 0) + 1);
      }

      totalStorageBytes += row.size_bytes;
      if (row.device_session_id) {
        uniqueGuests.add(row.device_session_id);
      }
    }

    return {
      total_uploaded: result.rows.length,
      total_storage_bytes: totalStorageBytes,
      uploads_per_day: [...uploadsPerDay.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      unique_guest_count: uniqueGuests.size
    };
  }

  async hideMedia(organizerId: string, eventId: string, mediaId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');
    ensureUuid(mediaId, 'media_id');

    const result = await query<{ media_id: string }>(
      `
        UPDATE media m
        SET status = 'hidden'
        WHERE m.id = $1::uuid
          AND m.event_id = $2::uuid
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = m.event_id
              AND eo.organizer_id = $3::uuid
          )
        RETURNING m.id AS media_id
      `,
      [mediaId, eventId, organizerId]
    );

    const media = result.rows[0];
    if (!media) {
      throw new AppError(404, 'NOT_FOUND', 'Media not found');
    }

    return {
      success: true,
      media_id: media.media_id,
      status: 'hidden' as const
    };
  }

  async unhideMedia(organizerId: string, eventId: string, mediaId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');
    ensureUuid(mediaId, 'media_id');

    const result = await query<{ media_id: string }>(
      `
        UPDATE media m
        SET status = 'uploaded'
        WHERE m.id = $1::uuid
          AND m.event_id = $2::uuid
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = m.event_id
              AND eo.organizer_id = $3::uuid
          )
        RETURNING m.id AS media_id
      `,
      [mediaId, eventId, organizerId]
    );

    const media = result.rows[0];
    if (!media) {
      throw new AppError(404, 'NOT_FOUND', 'Media not found');
    }

    return {
      success: true,
      media_id: media.media_id,
      status: 'uploaded' as const
    };
  }

  async bulkHideMedia(organizerId: string, eventId: string, mediaIds: string[]) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'media_ids must contain at least one media id');
    }

    for (const mediaId of mediaIds) {
      ensureUuid(mediaId, 'media_id');
    }

    const result = await query<{ media_id: string }>(
      `
        UPDATE media m
        SET status = 'hidden'
        WHERE m.event_id = $1::uuid
          AND m.id = ANY($2::uuid[])
          AND m.status <> 'hidden'
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = m.event_id
              AND eo.organizer_id = $3::uuid
          )
        RETURNING m.id AS media_id
      `,
      [eventId, mediaIds, organizerId]
    );

    return {
      success: true,
      hidden_count: result.rowCount
    };
  }

  async getMediaDownloadUrl(organizerId: string, eventId: string, mediaId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');
    ensureUuid(mediaId, 'media_id');

    const result = await query<{ storage_path: string | null }>(
      `
        SELECT m.storage_path
        FROM media m
        WHERE m.id = $1::uuid
          AND m.event_id = $2::uuid
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = m.event_id
              AND eo.organizer_id = $3::uuid
          )
        LIMIT 1
      `,
      [mediaId, eventId, organizerId]
    );

    const media = result.rows[0];
    if (!media || !media.storage_path) {
      throw new AppError(404, 'NOT_FOUND', 'Media not found');
    }

    const downloadUrl = await createSignedStorageObjectUrl(
      env.storageOriginalsBucket,
      media.storage_path
    );

    return {
      download_url: downloadUrl,
      expires_at: new Date(Date.now() + env.signedUrlTtlSeconds * 1000).toISOString()
    };
  }

  async getMediaDownloadUrls(organizerId: string, eventId: string, mediaIds: string[]) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new AppError(400, 'INVALID_REQUEST', 'At least one media_id is required');
    }

    if (mediaIds.length > 100) {
      throw new AppError(400, 'INVALID_REQUEST', 'Cannot request more than 100 media URLs at once');
    }

    for (const mediaId of mediaIds) {
      ensureUuid(mediaId, 'media_id');
    }

    await queryOwnedEventBase(organizerId, eventId);

    const result = await query<DbMediaDownloadRow>(
      `
        SELECT
          m.id AS media_id,
          m.storage_path,
          COALESCE(m.uploaded_at, m.created_at) AS uploaded_at,
          COALESCE(m.uploader_name, ds.display_name) AS uploader_name
        FROM media m
        LEFT JOIN device_sessions ds ON ds.id = m.device_session_id
        WHERE m.event_id = $1::uuid
          AND m.id = ANY($2::uuid[])
          AND m.storage_path IS NOT NULL
          AND m.status IN ('uploaded', 'hidden')
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = m.event_id
              AND eo.organizer_id = $3::uuid
          )
      `,
      [eventId, mediaIds, organizerId]
    );

    const mediaById = new Map(result.rows.map((row) => [row.media_id, row]));
    const orderedRows = mediaIds
      .map((mediaId) => mediaById.get(mediaId))
      .filter((row): row is DbMediaDownloadRow => Boolean(row));

    if (orderedRows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'No downloadable media found for this selection');
    }

    const expiresAt = new Date(Date.now() + env.signedUrlTtlSeconds * 1000).toISOString();
    const items = await Promise.all(
      orderedRows.map(async (row) => {
        if (!row.storage_path) {
          throw new AppError(404, 'NOT_FOUND', `Media ${row.media_id} has no storage path`);
        }

        return {
          media_id: row.media_id,
          download_url: await createSignedStorageObjectUrl(env.storageOriginalsBucket, row.storage_path),
          file_name: buildDownloadFileName(row)
        };
      })
    );

    return {
      items,
      expires_at: expiresAt
    };
  }

  async downloadAll(organizerId: string, eventId: string, excludeHidden: boolean) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    await queryOwnedEventBase(organizerId, eventId);

    const jobId = randomUUID();

    await query(
      `
        INSERT INTO organizer_jobs (
          id,
          event_id,
          organizer_id,
          job_type,
          status,
          exclude_hidden,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'download_all',
          'processing',
          $4,
          now(),
          now()
        )
      `,
      [jobId, eventId, organizerId, excludeHidden]
    );

    const statsResult = await query<{ media_count: number }>(
      `
        SELECT COUNT(*)::int AS media_count
        FROM media
        WHERE event_id = $1::uuid
          AND ($2::boolean = false OR status <> 'hidden')
      `,
      [eventId, excludeHidden]
    );

    const mediaCount = statsResult.rows[0]?.media_count ?? 0;

    return {
      job_id: jobId,
      status: 'processing' as const,
      estimated_time_seconds: Math.max(5, Math.ceil(mediaCount / 10))
    };
  }

  async downloadSelected(organizerId: string, eventId: string, mediaIds: string[]) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    if (!mediaIds || mediaIds.length === 0) {
      throw new AppError(400, 'INVALID_REQUEST', 'At least one media_id is required');
    }

    if (mediaIds.length > 500) {
      throw new AppError(400, 'INVALID_REQUEST', 'Cannot download more than 500 items at once');
    }

    for (const mediaId of mediaIds) {
      ensureUuid(mediaId, 'media_id');
    }

    await queryOwnedEventBase(organizerId, eventId);

    const jobId = randomUUID();

    await query(
      `
        INSERT INTO organizer_jobs (
          id,
          event_id,
          organizer_id,
          job_type,
          status,
          exclude_hidden,
          media_ids,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'download_selected',
          'processing',
          true,
          $4::uuid[],
          now(),
          now()
        )
      `,
      [jobId, eventId, organizerId, mediaIds]
    );

    return {
      job_id: jobId,
      status: 'processing' as const,
      estimated_time_seconds: Math.max(5, Math.ceil(mediaIds.length / 10))
    };
  }

  async getJobStatus(organizerId: string, jobId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(jobId, 'job_id');

    const current = await this.getOwnedJob(organizerId, jobId);

    if (current.status === 'processing') {
      const createdAtMs = new Date(toIsoDateTime(current.created_at) ?? 0).getTime();
      if (Date.now() - createdAtMs >= 1_000) {
        await this.materializeDownloadJob(current);
      }
    }

    const refreshed = await this.getOwnedJob(organizerId, jobId);
    return {
      job_id: refreshed.id,
      status: refreshed.status,
      download_url: refreshed.download_url,
      download_urls: refreshed.download_urls,
      file_size_bytes: refreshed.file_size_bytes,
      expires_at: toIsoDateTime(refreshed.expires_at),
      error_message: refreshed.error_message
    };
  }

  async getGuests(organizerId: string, eventId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const event = await queryOwnedEventBase(organizerId, eventId);

    const result = await query<{
      session_id: string;
      display_name: string | null;
      upload_count: number;
      is_active: boolean;
      created_at: Date | string;
      last_active_at: Date | string;
    }>(
      `
        SELECT
          ds.id AS session_id,
          ds.display_name,
          COALESCE(mu.upload_count, 0)::int AS upload_count,
          ds.is_active,
          ds.created_at,
          ds.last_active_at
        FROM device_sessions ds
        LEFT JOIN (
          SELECT
            device_session_id,
            COUNT(*)::int AS upload_count
          FROM media
          WHERE status IN ('uploaded', 'hidden')
          GROUP BY device_session_id
        ) mu ON mu.device_session_id = ds.id
        WHERE ds.event_id = $1::uuid
        ORDER BY ds.created_at DESC
      `,
      [eventId]
    );

    return {
      guests: result.rows.map((guest) => ({
        session_id: guest.session_id,
        display_name: guest.display_name,
        upload_count: guest.upload_count,
        is_active: guest.is_active,
        created_at: toIsoDateTime(guest.created_at) ?? new Date().toISOString(),
        last_active_at: toIsoDateTime(guest.last_active_at) ?? new Date().toISOString()
      })),
      total_guests: result.rowCount,
      max_guests: event.max_guests
    };
  }

  async deactivateGuest(organizerId: string, eventId: string, sessionId: string) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');
    ensureUuid(sessionId, 'session_id');

    const result = await query<{ session_id: string }>(
      `
        UPDATE device_sessions ds
        SET
          is_active = false,
          last_active_at = now()
        WHERE ds.id = $1::uuid
          AND ds.event_id = $2::uuid
          AND EXISTS (
            SELECT 1
            FROM event_organizers eo
            WHERE eo.event_id = ds.event_id
              AND eo.organizer_id = $3::uuid
          )
        RETURNING ds.id AS session_id
      `,
      [sessionId, eventId, organizerId]
    );

    const guest = result.rows[0];
    if (!guest) {
      throw new AppError(404, 'NOT_FOUND', 'Guest session not found');
    }

    return {
      success: true,
      session_id: guest.session_id,
      is_active: false as const
    };
  }

  async updateCapacity(organizerId: string, eventId: string, input: CapacityUpdateInput) {
    ensureUuid(organizerId, 'organizer_id');
    ensureUuid(eventId, 'event_id');

    const current = await queryOwnedEventBase(organizerId, eventId);

    if (eventSettingsLocked(current)) {
      throw new AppError(
        403,
        'EVENT_SETTINGS_LOCKED',
        'Capacity and compression settings cannot be changed after the event has started'
      );
    }

    const nextMaxGuests = ensurePositiveInteger(input.max_guests, 'max_guests');
    const nextMaxUploadsPerGuest = ensurePositiveInteger(
      input.max_uploads_per_guest,
      'max_uploads_per_guest'
    );
    const nextCompressionMode = input.compression_mode
      ? ensureCompressionMode(input.compression_mode, 'compression_mode')
      : current.compression_mode;

    const nextFee = calculateTotalFeeMinor(nextMaxGuests, nextMaxUploadsPerGuest, nextCompressionMode);
    const feeDifference = nextFee - toNumber(current.total_fee);

    if (feeDifference > 0) {
      return this.paymentRedirect(feeDifference, current.currency);
    }

    await query(
      `
        UPDATE events
        SET
          max_guests = $1,
          max_uploads_per_guest = $2,
          compression_mode = $3,
          total_fee = $4
        WHERE id = $5::uuid
      `,
      [nextMaxGuests, nextMaxUploadsPerGuest, nextCompressionMode, nextFee, eventId]
    );

    const event = await queryOwnedEventDetail(organizerId, eventId);
    return {
      success: true,
      event: toEventDetail(event)
    };
  }

  private paymentRedirect(feeDifference: number, currency: string): PaymentRedirectResponse {
    const paymentReference = `pay_${randomUUID()}`;

    return {
      requires_payment: true,
      payment_url: `https://payments.eventpovcamera.app/pay/${paymentReference}`,
      payment_reference: paymentReference,
      fee_difference: feeDifference,
      currency
    };
  }

  private async getOwnedJob(organizerId: string, jobId: string): Promise<DbJobRow> {
    const result = await query<DbJobRow>(
      `
        SELECT
          id,
          event_id,
          organizer_id,
          status,
          exclude_hidden,
          media_ids,
          download_url,
          download_urls,
          file_size_bytes,
          expires_at,
          error_message,
          created_at
        FROM organizer_jobs
        WHERE id = $1::uuid
          AND organizer_id = $2::uuid
        LIMIT 1
      `,
      [jobId, organizerId]
    );

    const job = result.rows[0];
    if (!job) {
      throw new AppError(404, 'NOT_FOUND', 'Job not found');
    }

    return job;
  }

  private async materializeDownloadJob(job: DbJobRow): Promise<void> {
    const hasMediaIds = job.media_ids && job.media_ids.length > 0;
    const stats = await query<{ media_count: number; total_size: number | string }>(
      `
        SELECT
          COUNT(*)::int AS media_count,
          COALESCE(SUM(size_bytes), 0)::bigint AS total_size
        FROM media
        WHERE event_id = $1::uuid
          AND ($2::boolean = false OR status <> 'hidden')
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      `,
      [job.event_id, job.exclude_hidden, hasMediaIds ? job.media_ids : null]
    );

    const mediaCount = stats.rows[0]?.media_count ?? 0;
    const totalSize = toNumber(stats.rows[0]?.total_size);
    const shouldSplit = mediaCount > ZIP_SPLIT_FILE_COUNT || totalSize > ZIP_SPLIT_SIZE_BYTES;
    const expiresAt = new Date(Date.now() + env.signedUrlTtlSeconds * 1000).toISOString();

    const downloadUrl = shouldSplit ? null : buildArchiveDownloadUrl(job.event_id, job.id);
    const downloadUrls = shouldSplit
      ? [buildArchiveDownloadUrl(job.event_id, job.id, 1), buildArchiveDownloadUrl(job.event_id, job.id, 2)]
      : null;

    await query(
      `
        UPDATE organizer_jobs
        SET
          status = 'complete',
          download_url = $1,
          download_urls = $2::text[],
          file_size_bytes = $3,
          expires_at = $4::timestamptz,
          updated_at = now()
        WHERE id = $5::uuid
      `,
      [downloadUrl, downloadUrls, totalSize, expiresAt, job.id]
    );
  }
}

export const organizerService = new OrganizerService();
