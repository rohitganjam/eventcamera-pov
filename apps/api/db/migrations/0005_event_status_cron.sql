-- Auto-provision Supabase cron for event status sync.
-- This migration is idempotent and safe to rerun from scripts/db/setup.sh.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Insufficient privilege to create pg_cron extension; skipping.';
    END;
  ELSE
    RAISE NOTICE 'pg_cron extension is not available in this database; skipping cron provisioning.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_net;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Insufficient privilege to create pg_net extension; skipping.';
    END;
  ELSE
    RAISE NOTICE 'pg_net extension is not available in this database; skipping cron provisioning.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS supabase_vault;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Insufficient privilege to create supabase_vault extension; skipping.';
    END;
  ELSE
    RAISE NOTICE 'supabase_vault extension is not available in this database; skipping cron provisioning.';
  END IF;
END;
$$;

DO $$
DECLARE
  has_api_url_secret boolean;
  has_cron_token_secret boolean;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'cron schema not found; skipping event status cron provisioning.';
    RETURN;
  END IF;

  IF to_regnamespace('net') IS NULL THEN
    RAISE NOTICE 'net schema not found; skipping event status cron provisioning.';
    RETURN;
  END IF;

  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE NOTICE 'vault.decrypted_secrets not found; skipping event status cron provisioning.';
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
      'Vault secrets missing (pov_api_base_url and/or pov_internal_cron_token); skipping cron job provisioning.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pov-event-status-sync-12h') THEN
    PERFORM cron.unschedule('pov-event-status-sync-12h');
  END IF;

  PERFORM cron.schedule(
    'pov-event-status-sync-12h',
    '0 0,12 * * *',
    $cron$
    SELECT
      net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pov_api_base_url')
          || '/api/internal/event-status-sync',
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

  RAISE NOTICE 'Cron job pov-event-status-sync-12h has been created/updated.';
END;
$$;
