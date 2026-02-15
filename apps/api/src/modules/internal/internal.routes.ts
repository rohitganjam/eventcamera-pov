import { Router } from 'express';

import { internalEventStatusSync, internalMediaRetentionCleanup } from './internal.controller';

const internalRouter = Router();

internalRouter.post('/event-status-sync', internalEventStatusSync);
internalRouter.post('/media-retention-cleanup', internalMediaRetentionCleanup);

export { internalRouter };
