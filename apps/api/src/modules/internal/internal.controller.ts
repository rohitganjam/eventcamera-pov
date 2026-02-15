import type { NextFunction, Request, Response } from 'express';

import { env } from '../../config/env';
import { runEventStatusSyncOnce } from '../../cron/event-status-cron';
import { runMediaRetentionCleanupOnce } from '../../cron/media-retention-cron';
import { AppError } from '../../shared/errors/app-error';

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function assertInternalCronAuth(req: Request): void {
  if (!env.internalCronApiToken) {
    throw new AppError(
      503,
      'CRON_AUTH_NOT_CONFIGURED',
      'Internal cron auth token is not configured on the server'
    );
  }

  const token = req.header('authorization');
  if (token !== `Bearer ${env.internalCronApiToken}`) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid internal cron token');
  }
}

export const internalEventStatusSync = asyncHandler(async (req, res) => {
  assertInternalCronAuth(req);

  const result = await runEventStatusSyncOnce();
  res.status(200).json({
    success: true,
    result
  });
});

export const internalMediaRetentionCleanup = asyncHandler(async (req, res) => {
  assertInternalCronAuth(req);

  const result = await runMediaRetentionCleanupOnce();
  res.status(200).json({
    success: true,
    result
  });
});
