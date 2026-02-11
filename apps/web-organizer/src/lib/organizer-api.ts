import { createOrganizerApiClient } from '@poveventcam/api-client';

import { supabase } from './supabase';

function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/api$/i, '') || 'http://localhost:3000';
}

const baseUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000');

export const organizerApi = createOrganizerApiClient({
  baseUrl,
  credentials: 'include',
  getAccessToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
});
