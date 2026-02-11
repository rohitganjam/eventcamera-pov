import type { IncomingMessage, ServerResponse } from 'node:http';

import { app } from '../src/app';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const currentUrl = req.url ?? '/';

  // Vercel may pass either "/api/..." or stripped paths to the function.
  // Normalize so Express routes mounted under "/api" always match.
  if (!currentUrl.startsWith('/api')) {
    req.url = `/api${currentUrl.startsWith('/') ? '' : '/'}${currentUrl}`;
  }

  app(req, res);
}
