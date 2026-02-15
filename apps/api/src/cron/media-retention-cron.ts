import { query } from '../lib/db';
import { deleteStorageObject } from '../lib/storage';
import { env } from '../config/env';

const RETENTION_DAYS = 30;
const DAILY_RUN_HOUR_UTC = 1;
const MAX_MEDIA_PER_RUN = 250;

interface MediaCleanupRow {
  media_id: string;
  storage_path: string;
  thumb_path: string | null;
}

export interface MediaRetentionCleanupResult {
  processed: number;
  cleaned: number;
  failed: number;
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
        m.storage_path,
        m.thumb_path
      FROM media m
      INNER JOIN events e ON e.id = m.event_id
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

async function markCleanupSuccess(mediaId: string): Promise<void> {
  await query(
    `
      UPDATE media
      SET
        status = 'expired',
        storage_deleted_at = now(),
        storage_last_delete_error = NULL
      WHERE id = $1::uuid
    `,
    [mediaId]
  );
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

      await markCleanupSuccess(item.media_id);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      await markCleanupFailure(item.media_id, toErrorMessage(error));
    }
  }

  return {
    processed: candidates.length,
    cleaned,
    failed,
    retention_days: RETENTION_DAYS,
    executed_at: new Date().toISOString()
  };
}

export function startMediaRetentionCleanupCron(): void {
  const runAndLog = () => {
    void runMediaRetentionCleanupOnce()
      .then((result) => {
        console.log(
          `[cron] media retention cleanup complete: processed=${result.processed}, cleaned=${result.cleaned}, failed=${result.failed}, retention_days=${result.retention_days}`
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
