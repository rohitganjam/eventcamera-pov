-- Auto-provision Supabase cron for media retention cleanup.
-- This migration is idempotent and safe to rerun from scripts/db/setup.sh.

DO $$
DECLARE
  has_api_url_secret boolean;
  has_cron_token_secret boolean;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'cron schema not found; skipping media retention cron provisioning.';
    RETURN;
  END IF;

  IF to_regnamespace('net') IS NULL THEN
    RAISE NOTICE 'net schema not found; skipping media retention cron provisioning.';
    RETURN;
  END IF;

  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE NOTICE 'vault.decrypted_secrets not found; skipping media retention cron provisioning.';
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name = 'pov_api_base_url'
  ) INTO has_api_url_secret;

  SELECT EXISTS(
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name = 'pov_internal_cron_token'
  ) INTO has_cron_token_secret;

  IF NOT has_api_url_secret OR NOT has_cron_token_secret THEN
    RAISE NOTICE
      'Vault secrets missing (pov_api_base_url and/or pov_internal_cron_token); skipping media retention cron provisioning.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pov-media-retention-cleanup-0100') THEN
    PERFORM cron.unschedule('pov-media-retention-cleanup-0100');
  END IF;

  PERFORM cron.schedule(
    'pov-media-retention-cleanup-0100',
    '0 1 * * *',
    $cron$
    SELECT
      net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pov_api_base_url')
          || '/api/internal/media-retention-cleanup',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'pov_internal_cron_token'
          )
        ),
        body := jsonb_build_object(
          'source', 'supabase-cron',
          'scheduled_at', now()
        )
      ) AS request_id;
    $cron$
  );

  RAISE NOTICE 'Cron job pov-media-retention-cleanup-0100 has been created/updated.';
END;
$$;
