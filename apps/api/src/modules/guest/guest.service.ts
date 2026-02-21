import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { env } from '../../config/env';
import { query, withTransaction } from '../../lib/db';
import {
  createSignedStorageObjectUrl,
  createSignedStorageUploadUrl,
  doesStorageObjectExist
} from '../../lib/storage';
import { addMediaToGalleryFacets } from '../organizer/gallery-facets.service';
import { AppError } from '../../shared/errors/app-error';

import { EventStatus } from '../../shared/types/event-status';

// EventStatus type removed, imported from shared
type CompressionMode = 'compressed' | 'raw';
type MediaStatus = 'pending' | 'uploaded' | 'failed' | 'expired' | 'hidden';
type RawFamily = 'standard' | 'raw';

interface JoinEventInput {
  event_slug?: unknown;
  pin?: unknown;
  display_name?: unknown;
}

interface PatchMySessionInput {
  display_name?: unknown;
}

interface CreateUploadInput {
  file_type?: unknown;
  file_size?: unknown;
  tags?: unknown;
}

interface CompleteUploadInput {
  media_id?: unknown;
}

interface DbEventRow {
  id: string;
  slug: string;
  name: string;
  status: EventStatus;
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode: CompressionMode;
  event_date: Date | string;
  end_date: Date | string;
  pin_hash: string | null;
}

interface DbJoinSessionRow {
  session_id: string;
  event_id: string;
  display_name: string | null;
  is_active: boolean;
  created_at: Date | string;
  last_active_at: Date | string;
}

interface DbGuestSessionRow {
  session_id: string;
  event_id: string;
  display_name: string | null;
  is_active: boolean;
  created_at: Date | string;
  last_active_at: Date | string;
  event_slug: string;
  event_name: string;
  event_status: EventStatus;
  max_uploads_per_guest: number;
  max_guests: number;
  compression_mode: CompressionMode;
  event_date: Date | string;
  end_date: Date | string;
}

interface DbUploadCountRow {
  upload_count: number;
}

interface DbCreateUploadRow {
  media_id: string;
  current_count: number;
}

interface DbMediaRow {
  media_id: string;
  status: MediaStatus;
  storage_path: string;
}

interface DbCompletedMediaRow extends DbMediaRow {
  event_id: string;
  uploader_name: string | null;
  tags: string[] | null;
}

interface DbMediaListRow {
  media_id: string;
  status: MediaStatus;
  uploaded_at: Date | string | null;
  thumb_path: string | null;
  storage_path: string;
  uploader_name: string | null;
  tags: string[] | null;
}

interface FileTypeRule {
  extension: string;
  family: RawFamily;
}

interface ResolvedGuestSession {
  session: {
    session_id: string;
    event_id: string;
    display_name: string | null;
    is_active: boolean;
    created_at: string;
    last_active_at: string;
  };
  event: {
    id: string;
    slug: string;
    name: string;
    status: EventStatus;
    max_uploads_per_guest: number;
    max_guests: number;
    compression_mode: CompressionMode;
    event_date: string;
    end_date: string;
    expires_at: string;
  };
}

const PIN_REGEX = /^\d{4}$/;
const EVENT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_MAX_LENGTH = 64;
const TAG_MAX_LENGTH = 32;
const TAG_MAX_COUNT = 8;
const DEVICE_SESSION_TOKEN_BYTES = 32;

const MAX_FILE_SIZE_COMPRESSED = 5 * 1024 * 1024;
const MAX_FILE_SIZE_RAW_STANDARD = 15 * 1024 * 1024;
const MAX_FILE_SIZE_RAW_FAMILY = 25 * 1024 * 1024;

const FILE_TYPE_RULES: Record<string, FileTypeRule> = {
  'image/jpeg': { extension: 'jpg', family: 'standard' },
  'image/png': { extension: 'png', family: 'standard' },
  'image/webp': { extension: 'webp', family: 'standard' },
  'image/heic': { extension: 'heic', family: 'standard' },
  'image/heif': { extension: 'heif', family: 'standard' },
  'image/x-canon-cr2': { extension: 'cr2', family: 'raw' },
  'application/x-canon-cr2': { extension: 'cr2', family: 'raw' },
  'image/x-nikon-nef': { extension: 'nef', family: 'raw' },
  'application/x-nikon-nef': { extension: 'nef', family: 'raw' },
  'image/x-sony-arw': { extension: 'arw', family: 'raw' },
  'application/x-sony-arw': { extension: 'arw', family: 'raw' },
  'image/x-adobe-dng': { extension: 'dng', family: 'raw' },
  'application/x-adobe-dng': { extension: 'dng', family: 'raw' },
  'image/x-olympus-orf': { extension: 'orf', family: 'raw' },
  'application/x-olympus-orf': { extension: 'orf', family: 'raw' },
  'image/x-panasonic-rw2': { extension: 'rw2', family: 'raw' },
  'application/x-panasonic-rw2': { extension: 'rw2', family: 'raw' }
};

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function ensureUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a valid UUID`, {
      field: fieldName
    });
  }

  return value;
}

function ensureSlug(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'event_slug is required', { field: 'event_slug' });
  }

  const normalized = value.trim().toLowerCase();
  if (!EVENT_SLUG_REGEX.test(normalized)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'event_slug is invalid', { field: 'event_slug' });
  }

  return normalized;
}

function ensureDisplayName(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a string`, {
      field: fieldName
    });
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      { field: fieldName }
    );
  }

  return normalized;
}

function ensurePin(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || !PIN_REGEX.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'pin must be a 4-digit string', { field: 'pin' });
  }

  return value;
}

function ensurePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AppError(400, 'VALIDATION_ERROR', `${fieldName} must be a positive integer`, {
      field: fieldName
    });
  }

  return value;
}

function ensureTags(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'tags must be an array of strings', {
      field: 'tags'
    });
  }

  if (value.length > TAG_MAX_COUNT) {
    throw new AppError(400, 'VALIDATION_ERROR', `tags can contain at most ${TAG_MAX_COUNT} items`, {
      field: 'tags'
    });
  }

  const normalized = value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new AppError(400, 'VALIDATION_ERROR', 'tags must be an array of strings', {
          field: 'tags'
        });
      }

      const tag = item.trim().toLowerCase();
      if (!tag) {
        return null;
      }

      if (tag.length > TAG_MAX_LENGTH) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `each tag must be at most ${TAG_MAX_LENGTH} characters`,
          { field: 'tags' }
        );
      }

      return tag;
    })
    .filter((item): item is string => Boolean(item));

  return [...new Set(normalized)];
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toISOString();
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toEndOfDayIso(date: string): string {
  const closeAt =
    new Date(`${date}T23:59:59.999Z`).getTime() + 13 * 60 * 60 * 1000;
  return new Date(closeAt).toISOString();
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureEventOpenForJoins(event: DbEventRow): void {
  if (event.status !== EventStatus.ACTIVE) {
    throw new AppError(403, 'EVENT_CLOSED', 'This event is not accepting guest joins');
  }
}

function ensureEventAcceptingUploads(session: ResolvedGuestSession): void {
  if (session.event.status !== EventStatus.ACTIVE) {
    throw new AppError(403, 'EVENT_CLOSED', 'This event is no longer accepting uploads');
  }
}

function ensureFileTypeForMode(fileType: string, mode: CompressionMode): FileTypeRule {
  const normalized = fileType.trim().toLowerCase();
  const rule = FILE_TYPE_RULES[normalized];
  if (!rule) {
    throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', `Unsupported file type: ${fileType}`);
  }

  if (mode === 'compressed') {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(normalized)) {
      throw new AppError(
        400,
        'UNSUPPORTED_FILE_TYPE',
        'Compressed mode only supports image/jpeg, image/png, and image/webp'
      );
    }
  } else if (mode === 'raw') {
    if (rule.family === 'raw') {
      return rule;
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(normalized)) {
      throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', `Unsupported file type for raw mode: ${fileType}`);
    }
  }

  return rule;
}

function resolveMaxFileSize(mode: CompressionMode, family: RawFamily): number {
  if (mode === 'compressed') {
    return MAX_FILE_SIZE_COMPRESSED;
  }

  return family === 'raw' ? MAX_FILE_SIZE_RAW_FAMILY : MAX_FILE_SIZE_RAW_STANDARD;
}

async function getEventBySlug(slug: string): Promise<DbEventRow> {
  const result = await query<DbEventRow>(
    `
      SELECT
        id,
        slug,
        name,
        status,
        max_guests,
        max_uploads_per_guest,
        compression_mode,
        event_date,
        end_date,
        pin_hash
      FROM events
      WHERE slug = $1
      LIMIT 1
    `,
    [slug]
  );

  const event = result.rows[0];
  if (!event) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
  }

  return event;
}

async function resolveSessionFromToken(deviceSessionToken: string): Promise<ResolvedGuestSession> {
  const tokenHash = hashValue(deviceSessionToken);

  const result = await query<DbGuestSessionRow>(
    `
      WITH touched AS (
        UPDATE device_sessions
        SET last_active_at = now()
        WHERE token_hash = $1
        RETURNING id, event_id, display_name, is_active, created_at, last_active_at
      )
      SELECT
        t.id AS session_id,
        t.event_id,
        t.display_name,
        t.is_active,
        t.created_at,
        t.last_active_at,
        e.slug AS event_slug,
        e.name AS event_name,
        e.status AS event_status,
        e.max_uploads_per_guest,
        e.max_guests,
        e.compression_mode,
        e.event_date,
        e.end_date
      FROM touched t
      JOIN events e ON e.id = t.event_id
      LIMIT 1
    `,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(401, 'UNAUTHORIZED', 'Guest session is missing or invalid');
  }

  if (!row.is_active) {
    throw new AppError(403, 'SESSION_INACTIVE', 'Guest session has been deactivated');
  }

  return {
    session: {
      session_id: row.session_id,
      event_id: row.event_id,
      display_name: row.display_name,
      is_active: row.is_active,
      created_at: toIsoDateTime(row.created_at) ?? new Date().toISOString(),
      last_active_at: toIsoDateTime(row.last_active_at) ?? new Date().toISOString()
    },
    event: {
      id: row.event_id,
      slug: row.event_slug,
      name: row.event_name,
      status: row.event_status,
      max_uploads_per_guest: row.max_uploads_per_guest,
      max_guests: row.max_guests,
      compression_mode: row.compression_mode,
      event_date: toIsoDate(row.event_date),
      end_date: toIsoDate(row.end_date),
      expires_at: toEndOfDayIso(toIsoDate(row.end_date))
    }
  };
}

async function getSessionUploadCount(sessionId: string): Promise<number> {
  const result = await query<DbUploadCountRow>(
    `
      SELECT COUNT(*)::int AS upload_count
      FROM media
      WHERE device_session_id = $1::uuid
        AND status IN ('pending', 'uploaded')
    `,
    [sessionId]
  );

  return result.rows[0]?.upload_count ?? 0;
}

function buildSessionResponse(
  session: ResolvedGuestSession,
  uploadCount: number
): {
  session: ResolvedGuestSession['session'];
  event: ResolvedGuestSession['event'];
  upload_count: number;
  max_uploads: number;
} {
  return {
    session: session.session,
    event: session.event,
    upload_count: uploadCount,
    max_uploads: session.event.max_uploads_per_guest
  };
}

async function joinEvent(input: JoinEventInput): Promise<{
  device_session_token: string;
  response: {
    session: ResolvedGuestSession['session'];
    event: ResolvedGuestSession['event'];
    upload_count: number;
    max_uploads: number;
  };
}> {
  const payload = ensureObject(input);
  const eventSlug = ensureSlug(payload.event_slug);
  const displayName = ensureDisplayName(payload.display_name, 'display_name');
  const pin = ensurePin(payload.pin);

  const event = await getEventBySlug(eventSlug);
  ensureEventOpenForJoins(event);

  if (event.pin_hash) {
    if (!pin || hashValue(pin) !== event.pin_hash) {
      throw new AppError(401, 'INVALID_PIN', 'Invalid event PIN');
    }
  }

  const deviceSessionToken = randomBytes(DEVICE_SESSION_TOKEN_BYTES).toString('hex');
  const tokenHash = hashValue(deviceSessionToken);

  const insertResult = await query<DbJoinSessionRow>(
    `
      WITH guest_check AS (
        SELECT COUNT(*)::int AS current_count
        FROM device_sessions
        WHERE event_id = $1::uuid
          AND is_active = true
      ),
      inserted AS (
        INSERT INTO device_sessions (id, event_id, token_hash, display_name, is_active)
        SELECT gen_random_uuid(), $1::uuid, $2, $3, true
        FROM guest_check
        WHERE guest_check.current_count < $4::int
        RETURNING id, event_id, display_name, is_active, created_at, last_active_at
      )
      SELECT
        id AS session_id,
        event_id,
        display_name,
        is_active,
        created_at,
        last_active_at
      FROM inserted
      LIMIT 1
    `,
    [event.id, tokenHash, displayName, event.max_guests]
  );

  const row = insertResult.rows[0];
  if (!row) {
    throw new AppError(403, 'EVENT_FULL', 'This event has reached its guest limit');
  }

  return {
    device_session_token: deviceSessionToken,
    response: {
      session: {
        session_id: row.session_id,
        event_id: row.event_id,
        display_name: row.display_name,
        is_active: row.is_active,
        created_at: toIsoDateTime(row.created_at) ?? new Date().toISOString(),
        last_active_at: toIsoDateTime(row.last_active_at) ?? new Date().toISOString()
      },
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        status: event.status,
        max_uploads_per_guest: event.max_uploads_per_guest,
        max_guests: event.max_guests,
        compression_mode: event.compression_mode,
        event_date: toIsoDate(event.event_date),
        end_date: toIsoDate(event.end_date),
        expires_at: toEndOfDayIso(toIsoDate(event.end_date))
      },
      upload_count: 0,
      max_uploads: event.max_uploads_per_guest
    }
  };
}

async function getMySession(deviceSessionToken: string): Promise<{
  session: ResolvedGuestSession['session'];
  event: ResolvedGuestSession['event'];
  upload_count: number;
  max_uploads: number;
}> {
  const session = await resolveSessionFromToken(deviceSessionToken);
  const uploadCount = await getSessionUploadCount(session.session.session_id);
  return buildSessionResponse(session, uploadCount);
}

async function patchMySession(
  deviceSessionToken: string,
  input: PatchMySessionInput
): Promise<{
  session: ResolvedGuestSession['session'];
  event: ResolvedGuestSession['event'];
  upload_count: number;
  max_uploads: number;
}> {
  const payload = ensureObject(input);
  if (!Object.prototype.hasOwnProperty.call(payload, 'display_name')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'display_name is required', {
      field: 'display_name'
    });
  }

  const displayName = ensureDisplayName(payload.display_name, 'display_name');
  const session = await resolveSessionFromToken(deviceSessionToken);

  const updateResult = await query<DbJoinSessionRow>(
    `
      UPDATE device_sessions
      SET display_name = $1,
          last_active_at = now()
      WHERE id = $2::uuid
      RETURNING
        id AS session_id,
        event_id,
        display_name,
        is_active,
        created_at,
        last_active_at
    `,
    [displayName, session.session.session_id]
  );

  const updated = updateResult.rows[0];
  if (!updated) {
    throw new AppError(401, 'UNAUTHORIZED', 'Guest session is missing or invalid');
  }

  const uploadCount = await getSessionUploadCount(updated.session_id);
  return {
    session: {
      session_id: updated.session_id,
      event_id: updated.event_id,
      display_name: updated.display_name,
      is_active: updated.is_active,
      created_at: toIsoDateTime(updated.created_at) ?? new Date().toISOString(),
      last_active_at: toIsoDateTime(updated.last_active_at) ?? new Date().toISOString()
    },
    event: session.event,
    upload_count: uploadCount,
    max_uploads: session.event.max_uploads_per_guest
  };
}

async function createUpload(
  deviceSessionToken: string,
  input: CreateUploadInput
): Promise<{
  media_id: string;
  upload_url: string;
  thumb_upload_url: string;
  remaining_uploads: number;
  compression_mode: CompressionMode;
  max_file_size: number;
}> {
  const payload = ensureObject(input);
  const fileType = typeof payload.file_type === 'string' ? payload.file_type.trim().toLowerCase() : '';
  if (!fileType) {
    throw new AppError(400, 'VALIDATION_ERROR', 'file_type is required', { field: 'file_type' });
  }

  const fileSize = ensurePositiveInteger(payload.file_size, 'file_size');
  const tags = ensureTags(payload.tags);

  const session = await resolveSessionFromToken(deviceSessionToken);
  ensureEventAcceptingUploads(session);

  const fileTypeRule = ensureFileTypeForMode(fileType, session.event.compression_mode);
  const maxFileSize = resolveMaxFileSize(session.event.compression_mode, fileTypeRule.family);
  if (fileSize > maxFileSize) {
    throw new AppError(400, 'FILE_TOO_LARGE', `File exceeds max size of ${maxFileSize} bytes`, {
      max_file_size: maxFileSize
    });
  }

  const mediaId = randomUUID();
  const storagePath = `${session.event.id}/${mediaId}.${fileTypeRule.extension}`;
  const thumbPath = `${session.event.id}/${mediaId}.jpg`;

  const uploadUrl = await createSignedStorageUploadUrl(env.storageOriginalsBucket, storagePath);
  const thumbUploadUrl = await createSignedStorageUploadUrl(env.storageThumbsBucket, thumbPath);

  const insertResult = await query<DbCreateUploadRow>(
    `
      WITH quota_check AS (
        SELECT COUNT(*)::int AS current_count
        FROM media
        WHERE device_session_id = $1::uuid
          AND status IN ('pending', 'uploaded')
      ),
      inserted AS (
        INSERT INTO media (
          id,
          event_id,
          device_session_id,
          storage_path,
          thumb_path,
          mime_type,
          size_bytes,
          uploader_name,
          tags,
          status
        )
        SELECT
          $2::uuid,
          $3::uuid,
          $1::uuid,
          $4,
          $5,
          $6,
          $7::int,
          $9,
          $10::text[],
          'pending'
        FROM quota_check
        WHERE quota_check.current_count < $8::int
        RETURNING id
      )
      SELECT
        inserted.id AS media_id,
        quota_check.current_count
      FROM inserted
      CROSS JOIN quota_check
      LIMIT 1
    `,
    [
      session.session.session_id,
      mediaId,
      session.event.id,
      storagePath,
      thumbPath,
      fileType,
      fileSize,
      session.event.max_uploads_per_guest,
      session.session.display_name,
      tags
    ]
  );

  const reserved = insertResult.rows[0];
  if (!reserved) {
    throw new AppError(403, 'UPLOAD_LIMIT_REACHED', 'You have reached your upload limit');
  }

  const usedAfterReservation = reserved.current_count + 1;
  const remainingUploads = Math.max(session.event.max_uploads_per_guest - usedAfterReservation, 0);

  return {
    media_id: mediaId,
    upload_url: uploadUrl,
    thumb_upload_url: thumbUploadUrl,
    remaining_uploads: remainingUploads,
    compression_mode: session.event.compression_mode,
    max_file_size: maxFileSize
  };
}

async function completeUpload(
  deviceSessionToken: string,
  input: CompleteUploadInput
): Promise<{
  success: true;
  media_id: string;
  status: 'uploaded';
}> {
  const payload = ensureObject(input);
  const mediaId = ensureUuid(payload.media_id, 'media_id');

  const session = await resolveSessionFromToken(deviceSessionToken);

  const mediaResult = await query<DbMediaRow>(
    `
      SELECT
        id AS media_id,
        status,
        storage_path
      FROM media
      WHERE id = $1::uuid
        AND device_session_id = $2::uuid
      LIMIT 1
    `,
    [mediaId, session.session.session_id]
  );

  const media = mediaResult.rows[0];
  if (!media) {
    throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media item not found');
  }

  if (media.status !== 'pending') {
    throw new AppError(409, 'MEDIA_STATE_CONFLICT', 'Media upload is not in pending state');
  }

  const objectExists = await doesStorageObjectExist(env.storageOriginalsBucket, media.storage_path);
  if (!objectExists) {
    throw new AppError(409, 'UPLOAD_NOT_FOUND', 'Uploaded object not found in storage');
  }

  await withTransaction(async (client) => {
    const updateResult = await client.query<DbCompletedMediaRow>(
      `
        UPDATE media
        SET
          status = 'uploaded',
          uploaded_at = now()
        WHERE id = $1::uuid
          AND device_session_id = $2::uuid
          AND status = 'pending'
        RETURNING
          id AS media_id,
          event_id,
          status,
          storage_path,
          uploader_name,
          tags
      `,
      [mediaId, session.session.session_id]
    );

    const updated = updateResult.rows[0];
    if (!updated) {
      throw new AppError(409, 'MEDIA_STATE_CONFLICT', 'Media upload state changed; retry request');
    }

    await addMediaToGalleryFacets(client, {
      event_id: updated.event_id,
      uploader_name: updated.uploader_name,
      tags: updated.tags
    });
  });

  return {
    success: true,
    media_id: mediaId,
    status: 'uploaded'
  };
}

async function getMyUploads(deviceSessionToken: string): Promise<{
  uploads: Array<{
    media_id: string;
    thumb_url: string;
    original_url: string;
    status: MediaStatus;
    uploaded_at: string | null;
    uploader_name: string | null;
    tags: string[];
  }>;
  total_uploaded: number;
  max_uploads: number;
}> {
  const session = await resolveSessionFromToken(deviceSessionToken);

  const uploadsResult = await query<DbMediaListRow>(
    `
      SELECT
        id AS media_id,
        status,
        uploaded_at,
        thumb_path,
        storage_path,
        uploader_name,
        tags
      FROM media
      WHERE device_session_id = $1::uuid
      ORDER BY COALESCE(uploaded_at, created_at) DESC, created_at DESC
    `,
    [session.session.session_id]
  );

  const uploads = await Promise.all(
    uploadsResult.rows.map(async (item: DbMediaListRow) => {
      const path = item.thumb_path ?? item.storage_path;
      const bucket = item.thumb_path ? env.storageThumbsBucket : env.storageOriginalsBucket;
      const thumbUrl = await createSignedStorageObjectUrl(bucket, path);
      const originalUrl = await createSignedStorageObjectUrl(
        env.storageOriginalsBucket,
        item.storage_path
      );

      return {
        media_id: item.media_id,
        thumb_url: thumbUrl,
        original_url: originalUrl,
        status: item.status,
        uploaded_at: toIsoDateTime(item.uploaded_at),
        uploader_name: item.uploader_name,
        tags: item.tags ?? []
      };
    })
  );

  const totalUploaded = uploadsResult.rows.reduce((count: number, item: DbMediaListRow) => {
    return item.status === 'uploaded' ? count + 1 : count;
  }, 0);

  return {
    uploads,
    total_uploaded: totalUploaded,
    max_uploads: session.event.max_uploads_per_guest
  };
}

interface LookupEventInput {
  event_slug?: unknown;
}

async function lookupEvent(input: LookupEventInput): Promise<{
  id: string;
  slug: string;
  name: string;
  status: EventStatus;
  requires_pin: boolean;
  end_date: string;
  expires_at: string;
  event_date: string;
}> {
  const payload = ensureObject(input);
  const eventSlug = ensureSlug(payload.event_slug);

  const event = await getEventBySlug(eventSlug);

  const eventDate = toIsoDate(event.event_date);
  const endDate = toIsoDate(event.end_date);
  const isActive = event.status === 'active';

  if (!isActive) {
    throw new AppError(403, 'EVENT_CLOSED', 'This event is not accepting guest joins');
  }

  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    status: event.status,
    requires_pin: Boolean(event.pin_hash),
    end_date: endDate,
    expires_at: toEndOfDayIso(endDate),
    event_date: eventDate
  };
}

export const guestService = {
  lookupEvent,
  joinEvent,
  getMySession,
  patchMySession,
  createUpload,
  completeUpload,
  getMyUploads
};
