import type { QueryParams } from '../core/http';

export type UUID = string;
export const COMPRESSION_MODE = {
  COMPRESSED: 'compressed',
  RAW: 'raw'
} as const;
export type CompressionMode = (typeof COMPRESSION_MODE)[keyof typeof COMPRESSION_MODE];
export type EventStatus = 'draft' | 'active' | 'closed' | 'archived' | 'purged';
export type CurrencyCode = string;

export interface EventStats {
  total_uploads?: number;
  total_storage_bytes?: number;
  unique_guest_count?: number;
}

export interface EventSummary {
  id: UUID;
  name: string;
  slug: string;
  status: EventStatus;
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode: CompressionMode;
  total_fee: number;
  currency: CurrencyCode;
  event_date: string;
  end_date: string;
  guest_url?: string;
  total_uploads?: number;
  guest_count?: number;
  created_at: string;
}

export interface EventDetail extends EventSummary {
  pin_enabled?: boolean;
  cover_image_path?: string | null;
  stats?: EventStats;
}

export interface CreateEventRequest {
  name: string;
  event_date: string;
  end_date?: string;
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode?: CompressionMode;
  pin?: string | null;
  cover_image_path?: string | null;
  currency?: CurrencyCode;
}

export interface PatchEventRequest {
  name?: string;
  pin?: string | null;
  max_guests?: number;
  max_uploads_per_guest?: number;
  compression_mode?: CompressionMode;
}

export interface CapacityUpdateRequest {
  max_guests: number;
  max_uploads_per_guest: number;
  compression_mode?: CompressionMode;
}

export interface CreateEventSuccessResponse {
  event: EventDetail;
}

export interface EventMutationSuccessResponse {
  success: boolean;
  event: EventDetail;
}

export interface PaymentRedirectResponse {
  requires_payment: true;
  payment_url: string;
  payment_reference?: string;
  fee_difference: number;
  currency: CurrencyCode;
}

export type CreateEventResponse = CreateEventSuccessResponse | PaymentRedirectResponse;
export type PatchEventResponse = EventMutationSuccessResponse | PaymentRedirectResponse;
export type CapacityUpdateResponse = EventMutationSuccessResponse | PaymentRedirectResponse;

export interface ListEventsResponse {
  events: EventSummary[];
}

export interface EventDetailResponse {
  event: EventDetail;
}

export interface GalleryQuery extends QueryParams {
  cursor?: string;
  limit?: number;
  sort?: 'newest' | 'oldest';
  sort_by?: 'uploaded_at' | 'uploader' | 'tag';
  sort_order?: 'asc' | 'desc';
  filter_date?: string;
  filter_session?: UUID;
  // Comma-separated uploader names; API matches if any selected uploader matches (OR).
  filter_uploader?: string;
  // Comma-separated tags; API matches if any selected tag matches (OR).
  filter_tag?: string;
  // Filter groups (uploader/tag/file_type/date/session) are combined with AND.
  filter_file_type?: 'image' | 'video';
}

export interface GalleryFacetsQuery extends QueryParams {
  uploader_q?: string;
  tag_q?: string;
  limit?: number;
}

export interface GalleryFacetItem {
  value: string;
  count: number;
}

export interface GalleryFileTypeFacetItem {
  value: 'image' | 'video';
  count: number;
}

export interface GalleryFacetsResponse {
  uploaders: GalleryFacetItem[];
  tags: GalleryFacetItem[];
  file_types: GalleryFileTypeFacetItem[];
  generated_at: string;
  limit: number;
}

export interface GalleryItem {
  media_id: UUID;
  thumb_url: string;
  original_url: string;
  uploaded_by?: string | null;
  tags?: string[];
  uploaded_at: string;
  status: 'uploaded' | 'hidden' | 'pending' | 'failed' | 'expired';
  size_bytes: number;
  mime_type: string;
}

export interface GalleryResponse {
  media: GalleryItem[];
  next_cursor?: string | null;
  total_count: number;
}

export interface UploadsPerDayItem {
  date: string;
  count: number;
}

export interface GalleryStatsResponse {
  total_uploaded: number;
  total_storage_bytes: number;
  uploads_per_day: UploadsPerDayItem[];
  unique_guest_count: number;
}

export interface MediaMutationResponse {
  success: boolean;
  media_id: UUID;
  status: 'uploaded' | 'hidden';
}

export interface BulkHideRequest {
  media_ids: UUID[];
}

export interface BulkHideResponse {
  success: boolean;
  hidden_count: number;
}

export interface DownloadUrlResponse {
  download_url: string;
  expires_at: string;
}

export interface BatchDownloadUrlsRequest {
  media_ids: UUID[];
}

export interface BatchDownloadUrlItem {
  media_id: UUID;
  download_url: string;
  file_name: string;
}

export interface BatchDownloadUrlsResponse {
  items: BatchDownloadUrlItem[];
  expires_at: string;
}

export interface DownloadAllRequest {
  exclude_hidden?: boolean;
}

export interface DownloadSelectedRequest {
  media_ids: UUID[];
}

export interface DownloadAllResponse {
  job_id: UUID;
  status: 'processing';
  estimated_time_seconds?: number;
}

export interface JobStatusResponse {
  job_id: UUID;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  download_url?: string | null;
  download_urls?: string[] | null;
  file_size_bytes?: number | null;
  expires_at?: string | null;
  error_message?: string | null;
}

export interface GuestListItem {
  session_id: UUID;
  display_name?: string | null;
  upload_count: number;
  is_active: boolean;
  created_at: string;
  last_active_at: string;
}

export interface GuestsResponse {
  guests: GuestListItem[];
  total_guests: number;
  max_guests: number;
}

export interface DeactivateGuestResponse {
  success: boolean;
  session_id: UUID;
  is_active: false;
}

export interface OrganizerRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}
