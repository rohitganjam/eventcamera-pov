import type { PoolClient } from 'pg';

import { withTransaction } from '../../lib/db';

interface FacetMediaInput {
  event_id: string;
  uploader_name: string | null;
  tags: string[] | null;
}

interface CountRow {
  count: number;
}

export interface GalleryFacetRebuildResult {
  uploader_rows: number;
  tag_rows: number;
}

const FACET_TRACKED_STATUSES = new Set(['uploaded', 'hidden']);

function normalizeUploaderName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeTags(values: string[] | null): string[] {
  if (!values || values.length === 0) return [];
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized)];
}

export function isFacetTrackedMediaStatus(status: string | null): boolean {
  if (!status) return false;
  return FACET_TRACKED_STATUSES.has(status);
}

export async function addMediaToGalleryFacets(
  client: PoolClient,
  media: FacetMediaInput
): Promise<void> {
  const uploaderName = normalizeUploaderName(media.uploader_name);
  const tags = normalizeTags(media.tags);

  if (uploaderName) {
    await client.query(
      `
        INSERT INTO event_uploader_facets (event_id, uploader_name, media_count)
        VALUES ($1::uuid, $2, 1)
        ON CONFLICT (event_id, uploader_name)
        DO UPDATE
        SET
          media_count = event_uploader_facets.media_count + 1,
          updated_at = now()
      `,
      [media.event_id, uploaderName]
    );
  }

  if (tags.length > 0) {
    await client.query(
      `
        INSERT INTO event_tag_facets (event_id, tag, media_count)
        SELECT $1::uuid, tag_item, 1
        FROM unnest($2::text[]) AS tag_item
        ON CONFLICT (event_id, tag)
        DO UPDATE
        SET
          media_count = event_tag_facets.media_count + 1,
          updated_at = now()
      `,
      [media.event_id, tags]
    );
  }
}

export async function removeMediaFromGalleryFacets(
  client: PoolClient,
  media: FacetMediaInput
): Promise<void> {
  const uploaderName = normalizeUploaderName(media.uploader_name);
  const tags = normalizeTags(media.tags);

  if (uploaderName) {
    await client.query(
      `
        UPDATE event_uploader_facets
        SET
          media_count = GREATEST(media_count - 1, 0),
          updated_at = now()
        WHERE event_id = $1::uuid
          AND uploader_name = $2
      `,
      [media.event_id, uploaderName]
    );

    await client.query(
      `
        DELETE FROM event_uploader_facets
        WHERE event_id = $1::uuid
          AND uploader_name = $2
          AND media_count <= 0
      `,
      [media.event_id, uploaderName]
    );
  }

  if (tags.length > 0) {
    await client.query(
      `
        UPDATE event_tag_facets facets
        SET
          media_count = GREATEST(facets.media_count - updates.count_delta, 0),
          updated_at = now()
        FROM (
          SELECT
            tag_item AS tag,
            COUNT(*)::int AS count_delta
          FROM unnest($2::text[]) AS tag_item
          GROUP BY tag_item
        ) updates
        WHERE facets.event_id = $1::uuid
          AND facets.tag = updates.tag
      `,
      [media.event_id, tags]
    );

    await client.query(
      `
        DELETE FROM event_tag_facets
        WHERE event_id = $1::uuid
          AND tag = ANY($2::text[])
          AND media_count <= 0
      `,
      [media.event_id, tags]
    );
  }
}

export async function rebuildGalleryFacets(): Promise<GalleryFacetRebuildResult> {
  return withTransaction(async (client) => {
    await client.query('TRUNCATE event_uploader_facets, event_tag_facets');

    const uploaderInsert = await client.query<CountRow>(
      `
        WITH inserted AS (
          INSERT INTO event_uploader_facets (event_id, uploader_name, media_count)
          SELECT
            source.event_id,
            source.uploader_name,
            COUNT(*)::int AS media_count
          FROM (
            SELECT
              m.event_id,
              COALESCE(NULLIF(BTRIM(m.uploader_name), ''), NULLIF(BTRIM(ds.display_name), '')) AS uploader_name
            FROM media m
            LEFT JOIN device_sessions ds ON ds.id = m.device_session_id
            WHERE m.status IN ('uploaded', 'hidden')
          ) source
          WHERE source.uploader_name IS NOT NULL
          GROUP BY source.event_id, source.uploader_name
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count
        FROM inserted
      `
    );

    const tagInsert = await client.query<CountRow>(
      `
        WITH inserted AS (
          INSERT INTO event_tag_facets (event_id, tag, media_count)
          SELECT
            m.event_id,
            LOWER(BTRIM(tag_item)) AS tag,
            COUNT(*)::int AS media_count
          FROM media m
          CROSS JOIN LATERAL unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_item
          WHERE m.status IN ('uploaded', 'hidden')
            AND NULLIF(BTRIM(tag_item), '') IS NOT NULL
          GROUP BY m.event_id, LOWER(BTRIM(tag_item))
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count
        FROM inserted
      `
    );

    return {
      uploader_rows: uploaderInsert.rows[0]?.count ?? 0,
      tag_rows: tagInsert.rows[0]?.count ?? 0
    };
  });
}
