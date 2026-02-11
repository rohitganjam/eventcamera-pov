function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/api$/i, '') || 'http://localhost:3000';
}

const baseUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000');

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    request_id?: string | null;
    details?: Record<string, unknown>;
  };
}

export class GuestApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(params: {
    statusCode: number;
    code: string;
    message: string;
    requestId?: string | null;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'GuestApiError';
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.requestId = params.requestId ?? null;
    this.details = params.details ?? {};
  }
}

export interface GuestSession {
  session_id: string;
  event_id: string;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
  last_active_at: string;
}

export interface GuestEventMeta {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'closed' | 'archived' | 'purged';
  max_uploads_per_guest: number;
  max_guests: number;
  compression_mode: 'compressed' | 'raw';
  event_date: string;
  end_date: string;
  expires_at: string;
}

export interface GuestSessionPayload {
  session: GuestSession;
  event: GuestEventMeta;
  upload_count: number;
  max_uploads: number;
}

interface LookupEventRequest {
  event_slug: string;
}

export interface EventLookupResponse {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'closed' | 'archived' | 'purged';
  requires_pin: boolean;
  end_date: string;
  expires_at: string;
  event_date: string;
}

interface JoinRequest {
  event_slug: string;
  pin?: string | null;
  display_name?: string | null;
}

export interface CreateUploadRequest {
  file_type: string;
  file_size: number;
  tags?: string[];
}

export interface CreateUploadResponse {
  media_id: string;
  upload_url: string;
  thumb_upload_url?: string | null;
  remaining_uploads: number;
  compression_mode: 'compressed' | 'raw';
  max_file_size: number;
}

export interface CompleteUploadResponse {
  success: boolean;
  media_id: string;
  status: 'uploaded';
}

export interface MyUploadItem {
  media_id: string;
  thumb_url: string;
  status: 'uploaded' | 'pending' | 'failed' | 'expired' | 'hidden';
  uploaded_at: string | null;
  uploader_name?: string | null;
  tags?: string[];
}

export interface MyUploadsResponse {
  uploads: MyUploadItem[];
  total_uploaded: number;
  max_uploads: number;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function request<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
  }
): Promise<T> {
  const method = options?.method ?? 'GET';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    credentials: 'include',
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await parseBody(response);

  if (!response.ok) {
    const error = payload as ErrorEnvelope;
    throw new GuestApiError({
      statusCode: response.status,
      code: error?.error?.code ?? 'API_ERROR',
      message: error?.error?.message ?? 'Request failed',
      requestId: error?.error?.request_id ?? null,
      details: error?.error?.details ?? {}
    });
  }

  return payload as T;
}

export const guestApi = {
  lookupEvent(input: LookupEventRequest): Promise<EventLookupResponse> {
    return request('/api/lookup-event', {
      method: 'POST',
      body: input
    });
  },

  joinEvent(input: JoinRequest): Promise<GuestSessionPayload> {
    return request('/api/join', {
      method: 'POST',
      body: input
    });
  },

  getMySession(): Promise<GuestSessionPayload> {
    return request('/api/my-session');
  },

  patchMySession(display_name: string | null): Promise<GuestSessionPayload> {
    return request('/api/my-session', {
      method: 'PATCH',
      body: { display_name }
    });
  },

  createUpload(input: CreateUploadRequest): Promise<CreateUploadResponse> {
    return request('/api/create-upload', {
      method: 'POST',
      body: input
    });
  },

  completeUpload(media_id: string): Promise<CompleteUploadResponse> {
    return request('/api/complete-upload', {
      method: 'POST',
      body: { media_id }
    });
  },

  getMyUploads(): Promise<MyUploadsResponse> {
    return request('/api/my-uploads');
  }
};
