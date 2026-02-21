import { Router } from 'express';

import { organizerAuthMiddleware } from '../../middleware/organizer-auth';
import { organizerSessionCsrfMiddleware } from '../../middleware/organizer-session-csrf';

import {
  organizerArchiveEvent,
  organizerBulkHideMedia,
  organizerCloseEvent,
  organizerCreateSession,
  organizerCreateEvent,
  organizerDeleteSession,
  organizerDeactivateGuest,
  organizerDownloadAll,
  organizerDownloadSelected,
  organizerGetEvent,
  organizerGetGallery,
  organizerGetGalleryFacets,
  organizerGetGalleryStats,
  organizerGetGuests,
  organizerGetSession,
  organizerGetMediaDownloadUrls,
  organizerGetJobStatus,
  organizerGetMediaDownloadUrl,
  organizerHideMedia,
  organizerListEvents,
  organizerPatchEvent,
  organizerUnhideMedia,
  organizerUpdateCapacity
} from './organizer.controller';

const organizerRouter = Router();

organizerRouter.post('/auth/session', organizerCreateSession);
organizerRouter.get('/auth/session', organizerAuthMiddleware, organizerGetSession);
organizerRouter.delete('/auth/session', organizerSessionCsrfMiddleware, organizerDeleteSession);

organizerRouter.use(organizerAuthMiddleware);
organizerRouter.use(organizerSessionCsrfMiddleware);

organizerRouter.route('/events').post(organizerCreateEvent).get(organizerListEvents);
organizerRouter.route('/events/:id').get(organizerGetEvent).patch(organizerPatchEvent);
organizerRouter.post('/events/:id/close', organizerCloseEvent);
organizerRouter.post('/events/:id/archive', organizerArchiveEvent);
organizerRouter.get('/events/:id/gallery', organizerGetGallery);
organizerRouter.get('/events/:id/gallery/facets', organizerGetGalleryFacets);
organizerRouter.get('/events/:id/gallery/stats', organizerGetGalleryStats);
organizerRouter.post('/events/:id/media/:mid/hide', organizerHideMedia);
organizerRouter.post('/events/:id/media/:mid/unhide', organizerUnhideMedia);
organizerRouter.post('/events/:id/media/bulk-hide', organizerBulkHideMedia);
organizerRouter.post('/events/:id/media/download-urls', organizerGetMediaDownloadUrls);
organizerRouter.get('/events/:id/media/:mid/download-url', organizerGetMediaDownloadUrl);
organizerRouter.post('/events/:id/download-all', organizerDownloadAll);
organizerRouter.post('/events/:id/download-selected', organizerDownloadSelected);
organizerRouter.get('/jobs/:job_id', organizerGetJobStatus);
organizerRouter.get('/events/:id/guests', organizerGetGuests);
organizerRouter.post('/events/:id/guests/:sid/deactivate', organizerDeactivateGuest);
organizerRouter.post('/events/:id/capacity', organizerUpdateCapacity);

export { organizerRouter };
