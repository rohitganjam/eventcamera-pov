import { query, withTransaction } from '../lib/db';
import { deleteStorageObject } from '../lib/storage';
import { env } from '../config/env';
import {
  isFacetTrackedMediaStatus,
  rebuildGalleryFacets,
  removeMediaFromGalleryFacets
} from '../modules/organizer/gallery-facets.service';

const RETENTION_DAYS = 30;
const DAILY_RUN_HOUR_UTC = 1;
const MAX_MEDIA_PER_RUN = 250;

interface MediaCleanupRow {
  media_id: string;
  event_id: string;
  storage_path: string;
  thumb_path: string | null;
  status: string;
  uploader_name: string | null;
  tags: string[] | null;
}

interface CountRow {
  count: number;
}

export interface MediaRetentionCleanupResult {
  media: {
    processed: number;
    cleaned: number;
    failed: number;
  };
  organizer_sessions: {
    deleted_expired: number;
  };
  facets: {
    uploader_rows: number;
    tag_rows: number;
  };
  retention_days: number;
  executed_at: string;
}

function millisecondsUntilNextUtcDailyHour(targetHourUtc: number, anchor: Date = new Date()): number {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();
  const hour = anchor.getUTCHours();

  const nextBoundaryMs =
    hour < targetHourUtc
      ? Date.UTC(year, month, day, targetHourUtc, 0, 0, 0)
      : Date.UTC(year, month, day + 1, targetHourUtc, 0, 0, 0);

  return Math.max(nextBoundaryMs - anchor.getTime(), 1_000);
}

async function fetchCleanupCandidates(limit: number): Promise<MediaCleanupRow[]> {
  const result = await query<MediaCleanupRow>(
    `
      SELECT
        m.id AS media_id,
        m.event_id,
        m.storage_path,
        m.thumb_path,
        m.status,
        COALESCE(m.uploader_name, ds.display_name) AS uploader_name,
        m.tags
      FROM media m
      INNER JOIN events e ON e.id = m.event_id
      LEFT JOIN device_sessions ds ON ds.id = m.device_session_id
      WHERE m.storage_deleted_at IS NULL
        AND m.storage_path IS NOT NULL
        AND m.status IN ('uploaded', 'hidden', 'pending', 'failed', 'expired')
        AND e.status IN ('closed', 'archived', 'purged')
        AND now() >= (COALESCE(e.expires_at, now()) + ($1::int * INTERVAL '1 day'))
      ORDER BY m.created_at ASC
      LIMIT $2::int
    `,
    [RETENTION_DAYS, limit]
  );

  return result.rows;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

async function markCleanupSuccess(item: MediaCleanupRow): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE media
        SET
          status = 'expired',
          storage_deleted_at = now(),
          storage_last_delete_error = NULL
        WHERE id = $1::uuid
      `,
      [item.media_id]
    );

    if (isFacetTrackedMediaStatus(item.status)) {
      await removeMediaFromGalleryFacets(client, {
        event_id: item.event_id,
        uploader_name: item.uploader_name,
        tags: item.tags
      });
    }
  });
}

async function markCleanupFailure(mediaId: string, errorMessage: string): Promise<void> {
  await query(
    `
      UPDATE media
      SET
        storage_delete_attempts = storage_delete_attempts + 1,
        storage_last_delete_error = $2
      WHERE id = $1::uuid
    `,
    [mediaId, errorMessage.slice(0, 2000)]
  );
}

async function cleanupExpiredOrganizerSessions(): Promise<number> {
  const result = await query<CountRow>(
    `
      WITH deleted AS (
        DELETE FROM organizer_sessions
        WHERE expires_at <= now()
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count
      FROM deleted
    `
  );

  return result.rows[0]?.count ?? 0;
}

export async function runMediaRetentionCleanupOnce(): Promise<MediaRetentionCleanupResult> {
  const candidates = await fetchCleanupCandidates(MAX_MEDIA_PER_RUN);

  let cleaned = 0;
  let failed = 0;

  for (const item of candidates) {
    try {
      await deleteStorageObject(env.storageOriginalsBucket, item.storage_path);

      if (item.thumb_path) {
        await deleteStorageObject(env.storageThumbsBucket, item.thumb_path);
      }

      await markCleanupSuccess(item);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      await markCleanupFailure(item.media_id, toErrorMessage(error));
    }
  }

  const deletedExpiredSessions = await cleanupExpiredOrganizerSessions();
  const facetRebuild = await rebuildGalleryFacets();

  return {
    media: {
      processed: candidates.length,
      cleaned,
      failed
    },
    organizer_sessions: {
      deleted_expired: deletedExpiredSessions
    },
    facets: {
      uploader_rows: facetRebuild.uploader_rows,
      tag_rows: facetRebuild.tag_rows
    },
    retention_days: RETENTION_DAYS,
    executed_at: new Date().toISOString()
  };
}

export function startMediaRetentionCleanupCron(): void {
  const runAndLog = () => {
    void runMediaRetentionCleanupOnce()
      .then((result) => {
        console.log(
          `[cron] media retention cleanup complete: media_processed=${result.media.processed}, media_cleaned=${result.media.cleaned}, media_failed=${result.media.failed}, expired_organizer_sessions_deleted=${result.organizer_sessions.deleted_expired}, facets_uploader_rows=${result.facets.uploader_rows}, facets_tag_rows=${result.facets.tag_rows}, retention_days=${result.retention_days}`
        );
      })
      .catch((error) => {
        console.error('[cron] media retention cleanup failed', error);
      });
  };

  const scheduleNextRun = () => {
    const delay = millisecondsUntilNextUtcDailyHour(DAILY_RUN_HOUR_UTC);

    setTimeout(() => {
      runAndLog();
      scheduleNextRun();
    }, delay);
  };

  console.log('[cron] media retention cleanup scheduled daily at 01:00 UTC');
  scheduleNextRun();
}
