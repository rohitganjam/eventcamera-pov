import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express from 'express';

import { env } from './config/env';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { notFoundMiddleware } from './middleware/not-found';
import { requestIdMiddleware } from './middleware/request-id';
import { guestRouter } from './modules/guest/guest.routes';
import { internalRouter } from './modules/internal/internal.routes';
import { organizerRouter } from './modules/organizer/organizer.routes';
import { webhooksRouter } from './modules/webhooks/webhooks.routes';

const app = express();

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  if (hostname.endsWith('.vercel.app')) {
    return true;
  }

  return env.corsAllowedOrigins.some((allowedOrigin) => {
    try {
      return new URL(allowedOrigin).origin === parsed.origin;
    } catch {
      return allowedOrigin.replace(/\/+$/, '') === parsed.origin;
    }
  });
}

const corsOptions: CorsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  }
};

app.disable('x-powered-by');
app.use(requestIdMiddleware);
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'poveventcam-api',
    request_id: req.requestId
  });
});

app.use('/api', guestRouter);
app.use('/api/organizer', organizerRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/internal', internalRouter);

app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

export { app };
