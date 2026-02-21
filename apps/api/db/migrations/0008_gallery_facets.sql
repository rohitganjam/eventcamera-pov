CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS event_uploader_facets (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  uploader_name TEXT NOT NULL,
  media_count INT NOT NULL DEFAULT 0 CHECK (media_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, uploader_name)
);

CREATE INDEX IF NOT EXISTS idx_event_uploader_facets_event_count
  ON event_uploader_facets(event_id, media_count DESC, uploader_name);
CREATE INDEX IF NOT EXISTS idx_event_uploader_facets_name_trgm
  ON event_uploader_facets USING gin (uploader_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS event_tag_facets (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  media_count INT NOT NULL DEFAULT 0 CHECK (media_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_event_tag_facets_event_count
  ON event_tag_facets(event_id, media_count DESC, tag);
CREATE INDEX IF NOT EXISTS idx_event_tag_facets_tag_trgm
  ON event_tag_facets USING gin (tag gin_trgm_ops);

TRUNCATE event_uploader_facets, event_tag_facets;

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
GROUP BY source.event_id, source.uploader_name;

INSERT INTO event_tag_facets (event_id, tag, media_count)
SELECT
  m.event_id,
  LOWER(BTRIM(tag_item)) AS tag,
  COUNT(*)::int AS media_count
FROM media m
CROSS JOIN LATERAL unnest(COALESCE(m.tags, ARRAY[]::text[])) AS tag_item
WHERE m.status IN ('uploaded', 'hidden')
  AND NULLIF(BTRIM(tag_item), '') IS NOT NULL
GROUP BY m.event_id, LOWER(BTRIM(tag_item));
