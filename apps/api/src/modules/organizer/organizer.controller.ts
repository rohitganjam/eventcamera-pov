import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../shared/errors/app-error';
import {
  clearOrganizerSessionCookie,
  createOrganizerSessionFromSupabaseToken,
  getOrganizerSessionTokenFromCookie,
  revokeOrganizerSessionByToken,
  setOrganizerSessionCookie
} from './organizer-session';
import { organizerService } from './organizer.service';

function getOrganizerId(req: Request): string {
  const organizerId = req.organizer?.id;
  if (!organizerId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Organizer identity is missing');
  }

  return organizerId;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseGallerySortBy(value: unknown): 'uploaded_at' | 'uploader' | 'tag' | undefined {
  if (value === 'uploaded_at' || value === 'uploader' || value === 'tag') {
    return value;
  }
  return undefined;
}

function parseGallerySortOrder(value: unknown): 'asc' | 'desc' | undefined {
  if (value === 'asc' || value === 'desc') {
    return value;
  }
  return undefined;
}

function parseGalleryFileType(value: unknown): 'image' | 'video' | undefined {
  if (value === 'image' || value === 'video') {
    return value;
  }
  return undefined;
}

function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;

  const [scheme, token] = headerValue.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  if (!token.trim()) return null;

  return token.trim();
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export const organizerCreateEvent = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.createEvent(organizerId, req.body);
  res.status(200).json(payload);
});

export const organizerCreateSession = asyncHandler(async (req, res) => {
  const bearerToken = parseBearerToken(req.header('authorization'));
  if (!bearerToken) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing organizer bearer token');
  }

  const payload = await createOrganizerSessionFromSupabaseToken(
    bearerToken,
    req.header('user-agent')
  );
  setOrganizerSessionCookie(res, payload.session_token);

  res.status(200).json({
    organizer: payload.organizer,
    session: {
      expires_at: payload.expires_at
    }
  });
});

export const organizerGetSession = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  res.status(200).json({
    organizer: {
      id: organizerId,
      email: req.organizer?.email ?? null,
      name: req.organizer?.name ?? null
    },
    session: {
      auth_method: req.organizer?.auth_method ?? 'session',
      expires_at: req.organizer?.session_expires_at ?? null
    }
  });
});

export const organizerDeleteSession = asyncHandler(async (req, res) => {
  const sessionToken = getOrganizerSessionTokenFromCookie(req);
  if (sessionToken) {
    await revokeOrganizerSessionByToken(sessionToken);
  }

  clearOrganizerSessionCookie(res);
  res.status(200).json({
    success: true
  });
});

export const organizerListEvents = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.listEvents(organizerId);
  res.status(200).json(payload);
});

export const organizerGetEvent = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getEvent(organizerId, req.params.id);
  res.status(200).json(payload);
});

export const organizerPatchEvent = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.patchEvent(organizerId, req.params.id, req.body);
  res.status(200).json(payload);
});

export const organizerCloseEvent = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.closeEvent(organizerId, req.params.id);
  res.status(200).json(payload);
});

export const organizerArchiveEvent = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.archiveEvent(organizerId, req.params.id);
  res.status(200).json(payload);
});

export const organizerGetGallery = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getGallery(organizerId, req.params.id, {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    limit: parseOptionalNumber(req.query.limit),
    sort:
      req.query.sort === 'oldest' || req.query.sort === 'newest'
        ? req.query.sort
        : undefined,
    sort_by: parseGallerySortBy(req.query.sort_by),
    sort_order: parseGallerySortOrder(req.query.sort_order),
    filter_date: typeof req.query.filter_date === 'string' ? req.query.filter_date : undefined,
    filter_session:
      typeof req.query.filter_session === 'string' ? req.query.filter_session : undefined,
    filter_uploader:
      typeof req.query.filter_uploader === 'string' ? req.query.filter_uploader : undefined,
    filter_tag: typeof req.query.filter_tag === 'string' ? req.query.filter_tag : undefined,
    filter_file_type: parseGalleryFileType(req.query.filter_file_type)
  });

  res.status(200).json(payload);
});

export const organizerGetGalleryFacets = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getGalleryFacets(organizerId, req.params.id, {
    uploader_q: typeof req.query.uploader_q === 'string' ? req.query.uploader_q : undefined,
    tag_q: typeof req.query.tag_q === 'string' ? req.query.tag_q : undefined,
    limit: parseOptionalNumber(req.query.limit)
  });

  res.status(200).json(payload);
});

export const organizerGetGalleryStats = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getGalleryStats(organizerId, req.params.id);
  res.status(200).json(payload);
});

export const organizerHideMedia = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.hideMedia(organizerId, req.params.id, req.params.mid);
  res.status(200).json(payload);
});

export const organizerUnhideMedia = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.unhideMedia(organizerId, req.params.id, req.params.mid);
  res.status(200).json(payload);
});

export const organizerBulkHideMedia = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const mediaIds = Array.isArray(req.body?.media_ids) ? req.body.media_ids : [];
  const payload = await organizerService.bulkHideMedia(organizerId, req.params.id, mediaIds);
  res.status(200).json(payload);
});

export const organizerGetMediaDownloadUrl = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getMediaDownloadUrl(
    organizerId,
    req.params.id,
    req.params.mid
  );
  res.status(200).json(payload);
});

export const organizerGetMediaDownloadUrls = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const mediaIds = Array.isArray(req.body?.media_ids) ? req.body.media_ids : [];
  const payload = await organizerService.getMediaDownloadUrls(organizerId, req.params.id, mediaIds);
  res.status(200).json(payload);
});

export const organizerDownloadAll = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const excludeHidden = req.body?.exclude_hidden !== false;
  const payload = await organizerService.downloadAll(organizerId, req.params.id, excludeHidden);
  res.status(200).json(payload);
});

export const organizerDownloadSelected = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const mediaIds = Array.isArray(req.body?.media_ids) ? req.body.media_ids : [];
  const payload = await organizerService.downloadSelected(organizerId, req.params.id, mediaIds);
  res.status(200).json(payload);
});

export const organizerGetJobStatus = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getJobStatus(organizerId, req.params.job_id);
  res.status(200).json(payload);
});

export const organizerGetGuests = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.getGuests(organizerId, req.params.id);
  res.status(200).json(payload);
});

export const organizerDeactivateGuest = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.deactivateGuest(
    organizerId,
    req.params.id,
    req.params.sid
  );
  res.status(200).json(payload);
});

export const organizerUpdateCapacity = asyncHandler(async (req, res) => {
  const organizerId = getOrganizerId(req);
  const payload = await organizerService.updateCapacity(organizerId, req.params.id, req.body);
  res.status(200).json(payload);
});
