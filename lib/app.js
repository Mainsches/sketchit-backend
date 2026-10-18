import cors from 'cors';
import express from 'express';
import { createAnonymousAccount, createAuthMiddleware } from './auth.js';
import { createGenerationService } from './generationService.js';
import { parseFreeGenerationRequest, parseIdempotencyKey, parseSessionLabel } from './generationRequest.js';
import { toPublicGeneration } from './presenters.js';
import { createRateLimiter } from './rateLimit.js';
import { FREE_DAILY_LIMIT, getUsage, toUsagePayload } from './usage.js';

const SESSION_ITEMS_LIMIT = 20;

export const PLAN_CONFIG = {
  free: {
    key: 'free',
    title: 'Free',
    dailyLimit: FREE_DAILY_LIMIT,
    modes: ['balanced'],
    variations: false,
    available: true,
  },
  premium: {
    key: 'premium',
    title: 'Premium',
    dailyLimit: 50,
    modes: ['fast', 'balanced', 'premium'],
    variations: true,
    available: false,
  },
};

export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, code, ...extra });
}

const systemClock = { now: () => Date.now() };

export function createApp({ db, openai, config, clock = systemClock, logger = console, workerId }) {
  if (!openai?.images) throw new Error('createApp requires an OpenAI client');

  const service = createGenerationService({ db, openai, clock, config, logger, workerId });
  const requireAuth = createAuthMiddleware({ db, clock, sendError, logger });

  const ipLimiter = createRateLimiter({
    name: 'ip',
    windowMs: 5 * 60 * 1000,
    max: config.ipRateLimitPer5Min,
    keyFn: (req) => `ip:${req.ip}`,
    clock,
    sendError,
  });
  const authLimiter = createRateLimiter({
    name: 'auth',
    windowMs: 60 * 60 * 1000,
    max: config.authRateLimitPerHour,
    keyFn: (req) => `ip:${req.ip}`,
    clock,
    sendError,
  });
  const startLimiter = createRateLimiter({
    name: 'generation_start',
    windowMs: 10 * 60 * 1000,
    max: config.startRateLimitPer10Min,
    keyFn: (req) => req.auth && `user:${req.auth.userId}`,
    clock,
    sendError,
  });
  const readLimiter = createRateLimiter({
    name: 'read',
    windowMs: 5 * 60 * 1000,
    max: config.readRateLimitPer5Min,
    keyFn: (req) => req.auth && `user:${req.auth.userId}`,
    clock,
    sendError,
  });

  async function usagePayloadFor(userId, sessionId = null) {
    const usage = await getUsage(db, { userId, nowMs: clock.now() });
    return toUsagePayload(usage, { sessionId });
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(ipLimiter);
  if (config.corsOrigins.length) {
    app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'] }));
  }
  app.use(express.json({ limit: config.jsonBodyLimitBytes }));

  app.get('/', (_req, res) => {
    res.json({ ok: true, message: 'SketchIT backend is running' });
  });

  app.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      return res.json({ ok: true });
    } catch {
      return sendError(res, 503, 'UNHEALTHY', 'Service unavailable.');
    }
  });

  app.get('/plans', (_req, res) => {
    res.json({ ok: true, plans: PLAN_CONFIG });
  });

  app.post('/auth/anonymous', authLimiter, async (_req, res) => {
    const { userId, accessToken } = await createAnonymousAccount(db, { clock });
    return res.status(201).json({
      ok: true,
      userId,
      accessToken,
      tokenType: 'Bearer',
      accountType: 'anonymous',
      recoverable: false,
      usage: await usagePayloadFor(userId),
    });
  });

  async function handleUsage(req, res) {
    const sessionId = parseSessionLabel(req.params.sessionId);
    return res.json({ ok: true, usage: await usagePayloadFor(req.auth.userId, sessionId) });
  }

  app.get('/usage', requireAuth, readLimiter, handleUsage);
  app.get('/usage/:sessionId', requireAuth, readLimiter, handleUsage);

  app.post('/session/:sessionId/premium', requireAuth, async (req, res) => {
    const usage = await usagePayloadFor(req.auth.userId, parseSessionLabel(req.params.sessionId));
    return sendError(res, 403, 'PREMIUM_ACTIVATION_DISABLED', 'Premium access cannot be activated by the client.', {
      usage,
    });
  });

  app.get('/session/:sessionId', requireAuth, readLimiter, async (req, res) => {
    const sessionId = parseSessionLabel(req.params.sessionId);
    const usage = await usagePayloadFor(req.auth.userId, sessionId);
    const rows = await service.listOwnedGenerations(req.auth.userId, SESSION_ITEMS_LIMIT);
    return res.json({
      ok: true,
      sessionId,
      userKey: req.auth.userId,
      usage,
      items: rows.map((row) => toPublicGeneration(row)),
    });
  });

  app.get('/generation/:id', requireAuth, readLimiter, async (req, res) => {
    const row = await service.getOwnedGeneration(req.auth.userId, req.params.id);
    if (!row) {
      return sendError(res, 404, 'GENERATION_NOT_FOUND', 'Generation not found.');
    }
    const usageSnapshot = await usagePayloadFor(req.auth.userId, row.client_session_id);
    return res.json({ ok: true, generation: toPublicGeneration(row, { usageSnapshot }) });
  });

  async function startFreeGeneration(req, res, { idempotencyRequired }) {
    const parsed = parseFreeGenerationRequest(req.body, config);
    if (!parsed.ok) {
      const usage = parsed.status === 402 || parsed.status === 403 ? await usagePayloadFor(req.auth.userId) : undefined;
      sendError(res, parsed.status, parsed.code, parsed.message, usage ? { usage } : {});
      return null;
    }

    const idempotency = parseIdempotencyKey(req, { required: idempotencyRequired });
    if (!idempotency.ok) {
      sendError(res, idempotency.status, idempotency.code, idempotency.message);
      return null;
    }

    const outcome = await service.startFreeGeneration({
      userId: req.auth.userId,
      idempotencyKey: idempotency.value,
      request: parsed.value,
    });

    if (outcome.type === 'limit') {
      const usage = await usagePayloadFor(req.auth.userId, parsed.value.sessionLabel);
      sendError(
        res,
        429,
        'DAILY_LIMIT_REACHED',
        `You have used your ${FREE_DAILY_LIMIT} free images today. Free images reset at 00:00 UTC.`,
        { usage }
      );
      return null;
    }

    if (outcome.type === 'conflict') {
      sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
      return null;
    }

    if (outcome.type === 'replay') res.set('Idempotent-Replayed', 'true');
    return outcome;
  }

  app.post('/generation/start', requireAuth, startLimiter, async (req, res) => {
    const outcome = await startFreeGeneration(req, res, { idempotencyRequired: true });
    if (!outcome) return undefined;

    const sessionId = outcome.row.client_session_id;
    const usage =
      outcome.type === 'created'
        ? toUsagePayload(outcome.usageAtStart, { sessionId })
        : await usagePayloadFor(req.auth.userId, sessionId);
    return res.json({
      ok: true,
      usage,
      generation: toPublicGeneration(outcome.row, { usageSnapshot: usage }),
      ...(outcome.type === 'replay' ? { idempotentReplay: true } : {}),
    });
  });

  app.post('/generation/:id/variation', requireAuth, startLimiter, async (req, res) => {
    const base = await service.getOwnedGeneration(req.auth.userId, req.params.id);
    if (!base) {
      return sendError(res, 404, 'BASE_NOT_FOUND', 'Base generation not found.');
    }
    const usage = await usagePayloadFor(req.auth.userId, base.client_session_id);
    return sendError(res, 403, 'PREMIUM_VARIATION_REQUIRED', 'Variations require coins, which are not available yet.', {
      usage,
    });
  });

  app.post('/generate', requireAuth, startLimiter, async (req, res) => {
    const outcome = await startFreeGeneration(req, res, { idempotencyRequired: false });
    if (!outcome) return undefined;

    if (outcome.job) await outcome.job;

    const row = await service.getOwnedGeneration(req.auth.userId, outcome.row.id);
    if (row?.status === 'done') {
      return res.json({
        ok: true,
        imageUrl: row.image_data_url,
        generationId: row.id,
        generationMode: row.generation_mode,
      });
    }
    if (row?.status === 'error') {
      return sendError(res, 502, 'LEGACY_FAILED', row.error_message ?? 'Image generation failed.', {
        generationId: row.id,
      });
    }
    return sendError(res, 409, 'GENERATION_IN_PROGRESS', 'This generation is still running.', {
      generationId: outcome.row.id,
    });
  });

  app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Route not found.'));

  // Express requires the four-argument signature to recognise error handlers.
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
    }
    if (error?.type === 'entity.parse.failed') {
      return sendError(res, 400, 'INVALID_JSON', 'The request body must be valid JSON.');
    }
    if (error?.status >= 400 && error?.status < 500 && error?.expose) {
      return sendError(res, error.status, 'BAD_REQUEST', 'The request could not be processed.');
    }
    logger.error?.('[http] unhandled error', error?.code || '', error?.message || error);
    if (res.headersSent) return undefined;
    return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  });

  return { app, service };
}
