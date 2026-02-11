const DEFAULT_PORT = 3000;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_GUEST_WEB_BASE_URL = 'https://guest.eventpovcamera.app';

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (!input) return fallback;

  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePort(input: string | undefined): number {
  if (!input) return DEFAULT_PORT;

  const parsed = Number.parseInt(input, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_PORT;
  }

  return parsed;
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) return fallback;

  const parsed = Number.parseInt(input, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseCsv(input: string | undefined): string[] {
  if (!input) return [];

  return input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseBaseUrl(input: string | undefined, fallback: string): string {
  const source = (input ?? fallback).trim();
  if (!source) return fallback;

  try {
    const normalized = new URL(source).origin;
    return normalized.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  throw new Error(`Missing required environment variable. Tried: ${names.join(', ')}`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parsePort(process.env.PORT),
  enableCronJobs: parseBoolean(process.env.ENABLE_CRON_JOBS, true),
  internalCronApiToken: process.env.INTERNAL_CRON_API_TOKEN ?? null,
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabasePublishableKey: requireFirstEnv([
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY'
  ]),
  supabaseSecretKey: requireFirstEnv(['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']),
  supabaseDbUrl: requireEnv('SUPABASE_DB_URL'),
  storageOriginalsBucket: process.env.SUPABASE_STORAGE_ORIGINALS_BUCKET ?? 'originals',
  storageThumbsBucket: process.env.SUPABASE_STORAGE_THUMBS_BUCKET ?? 'thumbs',
  storageArchiveBucket: process.env.SUPABASE_STORAGE_ARCHIVE_BUCKET ?? 'archives',
  signedUrlTtlSeconds: parsePositiveInt(
    process.env.SIGNED_URL_TTL_SECONDS,
    DEFAULT_SIGNED_URL_TTL_SECONDS
  ),
  corsAllowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS),
  guestWebBaseUrl: parseBaseUrl(process.env.GUEST_WEB_BASE_URL, DEFAULT_GUEST_WEB_BASE_URL)
};
