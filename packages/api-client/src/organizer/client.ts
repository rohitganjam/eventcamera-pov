import { ApiClientError, createHttpClient, type HttpClientConfig } from '../core/http';
import type { QueryParams } from '../core/http';
import type {
  BatchDownloadUrlsRequest,
  BatchDownloadUrlsResponse,
  BulkHideRequest,
  BulkHideResponse,
  CapacityUpdateRequest,
  CapacityUpdateResponse,
  CreateEventRequest,
  CreateEventResponse,
  DeactivateGuestResponse,
  DownloadAllRequest,
  DownloadAllResponse,
  DownloadSelectedRequest,
  DownloadUrlResponse,
  EventDetailResponse,
  EventMutationSuccessResponse,
  GalleryQuery,
  GalleryResponse,
  GalleryStatsResponse,
  GuestsResponse,
  JobStatusResponse,
  ListEventsResponse,
  MediaMutationResponse,
  OrganizerRequestOptions,
  PatchEventRequest,
  PatchEventResponse,
  UUID
} from './types';

export type OrganizerTokenProvider = () => string | null | Promise<string | null>;

export interface OrganizerClientConfig extends HttpClientConfig {
  getAccessToken: OrganizerTokenProvider;
}

export interface OrganizerApiClient {
  createEvent(body: CreateEventRequest, options?: OrganizerRequestOptions): Promise<CreateEventResponse>;
  listEvents(options?: OrganizerRequestOptions): Promise<ListEventsResponse>;
  getEvent(eventId: UUID, options?: OrganizerRequestOptions): Promise<EventDetailResponse>;
  patchEvent(
    eventId: UUID,
    body: PatchEventRequest,
    options?: OrganizerRequestOptions
  ): Promise<PatchEventResponse>;
  closeEvent(eventId: UUID, options?: OrganizerRequestOptions): Promise<EventMutationSuccessResponse>;
  archiveEvent(eventId: UUID, options?: OrganizerRequestOptions): Promise<EventMutationSuccessResponse>;
  getGallery(
    eventId: UUID,
    query?: GalleryQuery,
    options?: OrganizerRequestOptions
  ): Promise<GalleryResponse>;
  getGalleryStats(eventId: UUID, options?: OrganizerRequestOptions): Promise<GalleryStatsResponse>;
  hideMedia(eventId: UUID, mediaId: UUID, options?: OrganizerRequestOptions): Promise<MediaMutationResponse>;
  unhideMedia(eventId: UUID, mediaId: UUID, options?: OrganizerRequestOptions): Promise<MediaMutationResponse>;
  bulkHideMedia(
    eventId: UUID,
    body: BulkHideRequest,
    options?: OrganizerRequestOptions
  ): Promise<BulkHideResponse>;
  getMediaDownloadUrl(
    eventId: UUID,
    mediaId: UUID,
    options?: OrganizerRequestOptions
  ): Promise<DownloadUrlResponse>;
  getMediaDownloadUrls(
    eventId: UUID,
    body: BatchDownloadUrlsRequest,
    options?: OrganizerRequestOptions
  ): Promise<BatchDownloadUrlsResponse>;
  downloadAll(
    eventId: UUID,
    body?: DownloadAllRequest,
    options?: OrganizerRequestOptions
  ): Promise<DownloadAllResponse>;
  downloadSelected(
    eventId: UUID,
    body: DownloadSelectedRequest,
    options?: OrganizerRequestOptions
  ): Promise<DownloadAllResponse>;
  getJobStatus(jobId: UUID, options?: OrganizerRequestOptions): Promise<JobStatusResponse>;
  getGuests(eventId: UUID, options?: OrganizerRequestOptions): Promise<GuestsResponse>;
  deactivateGuest(
    eventId: UUID,
    sessionId: UUID,
    options?: OrganizerRequestOptions
  ): Promise<DeactivateGuestResponse>;
  updateCapacity(
    eventId: UUID,
    body: CapacityUpdateRequest,
    options?: OrganizerRequestOptions
  ): Promise<CapacityUpdateResponse>;
}

async function resolveAccessToken(provider: OrganizerTokenProvider): Promise<string> {
  const token = await provider();
  if (!token) {
    throw new ApiClientError({
      statusCode: 401,
      code: 'MISSING_ACCESS_TOKEN',
      message: 'Organizer access token is missing'
    });
  }

  return token;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function createOrganizerApiClient(config: OrganizerClientConfig): OrganizerApiClient {
  const http = createHttpClient(config);

  async function withAuth<T>(
    options: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      path: string;
      body?: unknown;
      query?: QueryParams;
      request?: OrganizerRequestOptions;
      responseType?: 'json' | 'text' | 'void';
    }
  ): Promise<T> {
    const token = await resolveAccessToken(config.getAccessToken);

    return http.request<T>({
      method: options.method,
      path: options.path,
      body: options.body,
      query: options.query,
      authToken: token,
      signal: options.request?.signal,
      idempotencyKey: options.request?.idempotencyKey,
      responseType: options.responseType
    });
  }

  return {
    createEvent(body, options) {
      return withAuth({
        method: 'POST',
        path: '/api/organizer/events',
        body,
        request: options
      });
    },

    listEvents(options) {
      return withAuth({
        method: 'GET',
        path: '/api/organizer/events',
        request: options
      });
    },

    getEvent(eventId, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/events/${encodePathSegment(eventId)}`,
        request: options
      });
    },

    patchEvent(eventId, body, options) {
      return withAuth({
        method: 'PATCH',
        path: `/api/organizer/events/${encodePathSegment(eventId)}`,
        body,
        request: options
      });
    },

    closeEvent(eventId, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/close`,
        request: options
      });
    },

    archiveEvent(eventId, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/archive`,
        request: options
      });
    },

    getGallery(eventId, query, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/gallery`,
        query,
        request: options
      });
    },

    getGalleryStats(eventId, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/gallery/stats`,
        request: options
      });
    },

    hideMedia(eventId, mediaId, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/media/${encodePathSegment(mediaId)}/hide`,
        request: options
      });
    },

    unhideMedia(eventId, mediaId, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/media/${encodePathSegment(mediaId)}/unhide`,
        request: options
      });
    },

    bulkHideMedia(eventId, body, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/media/bulk-hide`,
        body,
        request: options
      });
    },

    getMediaDownloadUrl(eventId, mediaId, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/media/${encodePathSegment(mediaId)}/download-url`,
        request: options
      });
    },

    getMediaDownloadUrls(eventId, body, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/media/download-urls`,
        body,
        request: options
      });
    },

    downloadAll(eventId, body, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/download-all`,
        body: body ?? {},
        request: options
      });
    },

    downloadSelected(eventId, body, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/download-selected`,
        body,
        request: options
      });
    },

    getJobStatus(jobId, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/jobs/${encodePathSegment(jobId)}`,
        request: options
      });
    },

    getGuests(eventId, options) {
      return withAuth({
        method: 'GET',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/guests`,
        request: options
      });
    },

    deactivateGuest(eventId, sessionId, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/guests/${encodePathSegment(sessionId)}/deactivate`,
        request: options
      });
    },

    updateCapacity(eventId, body, options) {
      return withAuth({
        method: 'POST',
        path: `/api/organizer/events/${encodePathSegment(eventId)}/capacity`,
        body,
        request: options
      });
    }
  };
}
