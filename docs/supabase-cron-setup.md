# Supabase Cron Setup (Call API)

This setup triggers internal API cron endpoints from Supabase:

- `POST /api/internal/event-status-sync` every 12 hours (`00:00` and `12:00` UTC)
- `POST /api/internal/media-retention-cleanup` daily at `01:00` UTC

`npm run db:setup --workspace @poveventcam/api` now also applies migrations:

- `0005_event_status_cron.sql`
- `0006_media_retention_cron.sql`

Both are idempotent and auto-create/update jobs when prerequisites are present.

## 1) Configure API

Set these in your API environment (for example in Vercel):

```env
ENABLE_CRON_JOBS=false
INTERNAL_CRON_API_TOKEN=<strong-random-token>
```

- `ENABLE_CRON_JOBS=false` disables in-process timers.
- `INTERNAL_CRON_API_TOKEN` protects the internal endpoint.

## 2) Enable required extensions in Supabase SQL editor

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
```

## 3) Store secrets in Vault

Replace placeholders with your deployed API URL and token.

```sql
select vault.create_secret('https://your-api-domain.com', 'pov_api_base_url');
select vault.create_secret('<same-token-as-INTERNAL_CRON_API_TOKEN>', 'pov_internal_cron_token');
```

## 4) Create the cron jobs (manual fallback)

If you ran `db:setup`, this step is usually handled automatically. Use this SQL only when you want to create/update jobs manually.

```sql
select cron.schedule(
  'pov-event-status-sync-12h',
  '0 0,12 * * *',
  $$
  select
    net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'pov_api_base_url')
        || '/api/internal/event-status-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'pov_internal_cron_token'
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduled_at', now()
      )
    ) as request_id;
  $$
);
```

```sql
select cron.schedule(
  'pov-media-retention-cleanup-0100',
  '0 1 * * *',
  $$
  select
    net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'pov_api_base_url')
        || '/api/internal/media-retention-cleanup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'pov_internal_cron_token'
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduled_at', now()
      )
    ) as request_id;
  $$
);
```

## 5) Verify and manage the job

```sql
-- list jobs
select * from cron.job
where jobname in ('pov-event-status-sync-12h', 'pov-media-retention-cleanup-0100');

-- unschedule if needed
select cron.unschedule('pov-event-status-sync-12h');
select cron.unschedule('pov-media-retention-cleanup-0100');
```
