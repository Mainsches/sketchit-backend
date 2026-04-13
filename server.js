import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import {
  normalizeText,
  normalizeMode,
  buildModePrompt,
  buildGenerationMode,
} from './lib/promptBuilder.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const generations = new Map();
const userSessions = new Map();
const sessionToUserKey = new Map();

const PLAN_CONFIG = {
  free: {
    key: 'free',
    title: 'Free',
    dailyLimit: 3,
    modes: ['balanced'],
    variations: false,
  },
  premium: {
    key: 'premium',
    title: 'Premium',
    dailyLimit: 50,
    modes: ['fast', 'balanced', 'premium'],
    variations: true,
  },
};

const FREE_DAILY_LIMIT = PLAN_CONFIG.free.dailyLimit;
const PREMIUM_DAILY_LIMIT = PLAN_CONFIG.premium.dailyLimit;

function createId(prefix = 'gen') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getUtcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function resolveUserKey(sessionId, deviceId) {
  const safeDeviceId = normalizeText(deviceId);
  const safeSessionId = normalizeText(sessionId);

  if (safeDeviceId) {
    return `device:${safeDeviceId}`;
  }

  if (safeSessionId) {
    return `session:${safeSessionId}`;
  }

  return `session:${createId('anon')}`;
}

function getImageUrlFromResult(result) {
  if (Array.isArray(result?.data) && result.data[0]?.url) {
    return result.data[0].url;
  }

  if (Array.isArray(result?.data) && result.data[0]?.b64_json) {
    return `data:image/png;base64,${result.data[0].b64_json}`;
  }

  return null;
}

function ensureUserUsage(session) {
  const todayKey = getUtcDayKey();

  if (!session.usage) {
    session.usage = {
      dayKey: todayKey,
      dailyCount: 0,
      pendingCount: 0,
      totalCount: 0,
    };
  }

  if (session.usage.dayKey !== todayKey) {
    session.usage.dayKey = todayKey;
    session.usage.dailyCount = 0;
    session.usage.pendingCount = 0;
  }

  return session.usage;
}

function getOrCreateUserSession({ sessionId, deviceId }) {
  const userKey = resolveUserKey(sessionId, deviceId);
  const safeSessionId = normalizeText(sessionId) || createId('session');
  const safeDeviceId = normalizeText(deviceId) || null;

  if (!userSessions.has(userKey)) {
    userSessions.set(userKey, {
      userKey,
      sessionId: safeSessionId,
      deviceId: safeDeviceId,
      generationIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isPremium: false,
      usage: {
        dayKey: getUtcDayKey(),
        dailyCount: 0,
        pendingCount: 0,
        totalCount: 0,
      },
    });
  }

  const session = userSessions.get(userKey);
  ensureUserUsage(session);

  if (safeSessionId) {
    session.sessionId = safeSessionId;
    sessionToUserKey.set(safeSessionId, userKey);
  }

  if (safeDeviceId) {
    session.deviceId = safeDeviceId;
  }

  return session;
}

function findExistingUserSession({ sessionId, deviceId }) {
  const safeDeviceId = normalizeText(deviceId);
  const safeSessionId = normalizeText(sessionId);

  if (safeDeviceId) {
    const userKey = resolveUserKey(safeSessionId, safeDeviceId);
    return userSessions.get(userKey) || null;
  }

  if (safeSessionId && sessionToUserKey.has(safeSessionId)) {
    const userKey = sessionToUserKey.get(safeSessionId);
    return userSessions.get(userKey) || null;
  }

  return null;
}

function getUsagePayload(session) {
  const usage = ensureUserUsage(session);
  const dailyLimit = session.isPremium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const remainingToday = Math.max(0, dailyLimit - usage.dailyCount);
  const remainingToStart = Math.max(0, dailyLimit - usage.dailyCount - usage.pendingCount);

  return {
    sessionId: session.sessionId,
    userKey: session.userKey,
    deviceId: session.deviceId || null,
    isPremium: Boolean(session.isPremium),
    dailyCount: usage.dailyCount,
    pendingCount: usage.pendingCount,
    dailyLimit,
    remainingToday,
    remainingToStart,
    totalCount: usage.totalCount,
    resetDayKey: usage.dayKey,
    canStartGeneration: remainingToStart > 0,
    canUsePremiumMode: Boolean(session.isPremium),
    canUseVariations: Boolean(session.isPremium),
  };
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    error: message,
    code,
    ...extra,
  });
}

function isCoinConsumptionSource(value) {
  return String(value ?? '').toLowerCase() === 'coin';
}

function validateUsageForGeneration(session, generationMode, isVariation = false, options = {}) {
  const usage = getUsagePayload(session);
  const billedWithCoin = Boolean(options?.billedWithCoin);

  if (!usage.isPremium && generationMode === 'premium') {
    return {
      allowed: false,
      status: 403,
      code: 'PREMIUM_MODE_REQUIRED',
      message: 'Premium mode is only available for premium users.',
      usage,
    };
  }

  if (!usage.isPremium && isVariation) {
    return {
      allowed: false,
      status: 403,
      code: 'PREMIUM_VARIATION_REQUIRED',
      message: 'Variations are only available for premium users.',
      usage,
    };
  }

  if (!billedWithCoin && usage.remainingToStart <= 0) {
    return {
      allowed: false,
      status: 429,
      code: 'DAILY_LIMIT_REACHED',
      message: usage.isPremium
        ? `You have used your ${PREMIUM_DAILY_LIMIT} premium images today.`
        : `You have used your ${FREE_DAILY_LIMIT} free images today. Upgrade to premium for more generations and variations.`,
      usage,
    };
  }

  return {
    allowed: true,
    usage,
  };
}

function registerGenerationStart(session, reserveFreeDailySlot = true) {
  const usage = ensureUserUsage(session);
  if (reserveFreeDailySlot) {
    usage.pendingCount += 1;
  }
  session.updatedAt = Date.now();
  return getUsagePayload(session);
}

function finalizeGenerationUsage(userKey, success, options = {}) {
  const session = userSessions.get(userKey);
  if (!session) return null;

  const { consumeFreeDaily = true, hadReservedFreeSlot = true } = options;

  const usage = ensureUserUsage(session);
  if (hadReservedFreeSlot) {
    usage.pendingCount = Math.max(0, usage.pendingCount - 1);
  }

  if (success) {
    if (consumeFreeDaily) {
      usage.dailyCount += 1;
    }
    usage.totalCount += 1;
  }

  session.updatedAt = Date.now();
  return getUsagePayload(session);
}

async function runGeneration({
  generationId,
  userKey,
  prompt,
  imageBase64,
  mimeType = 'image/jpeg',
  generationMode = 'balanced',
  variationIndex = 0,
  mode = 'product',
}) {
  const entry = generations.get(generationId);
  if (!entry) return;

  const billedWithCoin = isCoinConsumptionSource(entry.consumptionSource);
  const consumeFreeDaily = !billedWithCoin;
  const hadReservedFreeSlot = !billedWithCoin;

  try {
    entry.status = 'processing';
    entry.updatedAt = Date.now();

    let result;
    const imageGenMode = buildGenerationMode(generationMode);
    const openaiPrompt = buildModePrompt({
      mode,
      userPrompt: prompt,
      generationMode,
      variationIndex,
      hasSketch: Boolean(imageBase64),
    });

    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(cleanBase64, 'base64');
      const imageFile = await toFile(
        imageBuffer,
        mimeType === 'image/png' ? 'sketch.png' : 'sketch.jpg',
        { type: mimeType }
      );

      result = await openai.images.edit({
        model: 'gpt-image-1',
        image: imageFile,
        prompt: openaiPrompt,
        size: imageGenMode.apiSize,
      });
    } else {
      result = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: openaiPrompt,
        size: imageGenMode.apiSize,
      });
    }

    const imageUrl = getImageUrlFromResult(result);

    if (!imageUrl) {
      throw new Error('No image returned from OpenAI');
    }

    entry.status = 'done';
    entry.imageDataUrl = imageUrl;
    entry.imageBase64 = imageUrl.startsWith('data:image/') ? imageUrl.split(',')[1] : null;
    entry.updatedAt = Date.now();
    entry.completedAt = Date.now();
    entry.finishedAt = new Date().toISOString();
    entry.error = null;

    const usage = finalizeGenerationUsage(userKey, true, { consumeFreeDaily, hadReservedFreeSlot });
    if (usage) {
      entry.usageSnapshot = usage;
    }
  } catch (error) {
    entry.status = 'error';
    entry.error = {
      message: error?.message || 'Unknown generation error',
    };
    entry.updatedAt = Date.now();
    entry.finishedAt = new Date().toISOString();

    const usage = finalizeGenerationUsage(userKey, false, { consumeFreeDaily, hadReservedFreeSlot });
    if (usage) {
      entry.usageSnapshot = usage;
    }
  }
}

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'SketchIT backend is running' });
});

app.get('/plans', (_req, res) => {
  return res.json({
    ok: true,
    plans: PLAN_CONFIG,
  });
});

app.get('/usage/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const deviceId = req.query.deviceId;

  const existing = findExistingUserSession({ sessionId, deviceId });

  const session =
    existing ||
    getOrCreateUserSession({
      sessionId,
      deviceId,
    });

  return res.json({
    ok: true,
    usage: getUsagePayload(session),
  });
});

app.post('/session/:sessionId/premium', (req, res) => {
  const session = getOrCreateUserSession({
    sessionId: req.params.sessionId,
    deviceId: req.body?.deviceId,
  });

  const isPremium = Boolean(req.body?.isPremium);
  session.isPremium = isPremium;
  session.updatedAt = Date.now();

  return res.json({
    ok: true,
    usage: getUsagePayload(session),
  });
});

app.get('/session/:sessionId', (req, res) => {
  const session = findExistingUserSession({
    sessionId: req.params.sessionId,
    deviceId: req.query.deviceId,
  });

  if (!session) {
    return jsonError(res, 404, 'SESSION_NOT_FOUND', 'Session not found.');
  }

  const items = session.generationIds
    .map((id) => generations.get(id))
    .filter(Boolean);

  return res.json({
    ok: true,
    sessionId: session.sessionId,
    userKey: session.userKey,
    usage: getUsagePayload(session),
    items,
  });
});

app.get('/generation/:id', (req, res) => {
  const entry = generations.get(req.params.id);

  if (!entry) {
    return jsonError(res, 404, 'GENERATION_NOT_FOUND', 'Generation not found.');
  }

  return res.json({
    ok: true,
    generation: entry,
  });
});

app.post('/generation/start', async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mimeType = 'image/jpeg',
      sessionId,
      deviceId,
      generationMode = 'balanced',
      mode: aiMode,
      consumptionSource,
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);
    const mode = normalizeMode(aiMode);
    const billedWithCoin = isCoinConsumptionSource(consumptionSource);

    if (!safePrompt && !imageBase64) {
      return jsonError(res, 400, 'INVALID_INPUT', 'Either prompt or imageBase64 is required.');
    }

    const session = getOrCreateUserSession({ sessionId, deviceId });
    const access = validateUsageForGeneration(session, generationMode, false, { billedWithCoin });

    if (!access.allowed) {
      return jsonError(res, access.status, access.code, access.message, { usage: access.usage });
    }

    const usage = registerGenerationStart(session, !billedWithCoin);
    const generationId = createId('gen');

    const entry = {
      id: generationId,
      sessionId: session.sessionId,
      userKey: session.userKey,
      deviceId: session.deviceId || null,
      sourceGenerationId: null,
      prompt: safePrompt,
      type: 'base',
      mimeType,
      hasSketch: Boolean(imageBase64),
      imageBase64: null,
      imageDataUrl: null,
      generationMode,
      mode,
      consumptionSource: billedWithCoin ? 'coin' : null,
      status: 'pending',
      error: null,
      variationSeed: null,
      variationIntent: null,
      meta: {
        promptUsed: safePrompt,
        mode,
        ...(billedWithCoin ? { consumptionSource: 'coin' } : {}),
      },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      updatedAt: Date.now(),
      variationIndex: 0,
      usageSnapshot: usage,
    };

    generations.set(generationId, entry);
    session.generationIds.push(generationId);
    session.updatedAt = Date.now();

    runGeneration({
      generationId,
      userKey: session.userKey,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      generationMode,
      variationIndex: 0,
      mode,
    });

    return res.json({
      ok: true,
      usage,
      generation: entry,
    });
  } catch (error) {
    return jsonError(res, 500, 'START_FAILED', error?.message || 'Failed to start generation.');
  }
});

app.post('/generation/:id/variation', async (req, res) => {
  try {
    const base = generations.get(req.params.id);

    if (!base) {
      return jsonError(res, 404, 'BASE_NOT_FOUND', 'Base generation not found.');
    }

    const session = findExistingUserSession({
      sessionId: base.sessionId,
      deviceId: req.body?.deviceId || base.deviceId,
    });

    if (!session) {
      return jsonError(res, 404, 'SESSION_NOT_FOUND', 'Session not found.');
    }

    const {
      prompt = base.prompt,
      generationMode = base.generationMode || 'balanced',
      variationIntent = 'alternate',
      mode: aiMode,
      consumptionSource,
    } = req.body ?? {};

    const mode = normalizeMode(aiMode ?? base.mode);
    const billedWithCoin = isCoinConsumptionSource(consumptionSource);

    const access = validateUsageForGeneration(session, generationMode, true, { billedWithCoin });

    if (!access.allowed) {
      return jsonError(res, access.status, access.code, access.message, { usage: access.usage });
    }

    const usage = registerGenerationStart(session, !billedWithCoin);
    const variationId = createId('gen');
    const siblingCount = session.generationIds
      .map((id) => generations.get(id))
      .filter((item) => item?.sourceGenerationId === base.id).length;

    const entry = {
      id: variationId,
      sessionId: session.sessionId,
      userKey: session.userKey,
      deviceId: session.deviceId || null,
      sourceGenerationId: base.id,
      prompt: normalizeText(prompt),
      type: 'variation',
      mimeType: base.mimeType || 'image/jpeg',
      hasSketch: Boolean(base.hasSketch),
      imageBase64: null,
      imageDataUrl: null,
      generationMode,
      mode,
      consumptionSource: billedWithCoin ? 'coin' : null,
      status: 'pending',
      error: null,
      variationSeed: Math.floor(Math.random() * 1000000),
      variationIntent,
      meta: {
        promptUsed: normalizeText(prompt),
        mode,
        ...(billedWithCoin ? { consumptionSource: 'coin' } : {}),
      },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      updatedAt: Date.now(),
      variationIndex: siblingCount + 1,
      usageSnapshot: usage,
    };

    generations.set(variationId, entry);
    session.generationIds.push(variationId);
    session.updatedAt = Date.now();

    runGeneration({
      generationId: variationId,
      userKey: session.userKey,
      prompt: entry.prompt,
      imageBase64: null,
      mimeType: entry.mimeType,
      generationMode,
      variationIndex: entry.variationIndex,
      mode,
    });

    return res.json({
      ok: true,
      usage,
      generation: entry,
    });
  } catch (error) {
    return jsonError(res, 500, 'VARIATION_FAILED', error?.message || 'Failed to create variation.');
  }
});

app.post('/generate', async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mimeType = 'image/jpeg',
      generationMode = 'balanced',
      mode: aiMode,
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);
    const mode = normalizeMode(aiMode);

    if (!safePrompt && !imageBase64) {
      return jsonError(res, 400, 'INVALID_INPUT', 'Either prompt or imageBase64 is required.');
    }

    const generationId = createId('legacy');
    generations.set(generationId, {
      id: generationId,
      sessionId: null,
      userKey: null,
      deviceId: null,
      sourceGenerationId: null,
      prompt: safePrompt,
      type: 'base',
      mimeType,
      hasSketch: Boolean(imageBase64),
      imageBase64: null,
      imageDataUrl: null,
      generationMode,
      mode,
      status: 'pending',
      error: null,
      meta: {
        promptUsed: safePrompt,
        mode,
      },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      updatedAt: Date.now(),
      variationIndex: 0,
    });

    await runGeneration({
      generationId,
      userKey: null,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      generationMode,
      variationIndex: 0,
      mode,
    });

    const entry = generations.get(generationId);

    if (entry?.status !== 'done') {
      return jsonError(res, 500, 'LEGACY_FAILED', entry?.error?.message || 'Generation failed.');
    }

    return res.json({
      ok: true,
      imageUrl: entry.imageDataUrl,
      generationId,
      generationMode,
    });
  } catch (error) {
    return jsonError(res, 500, 'LEGACY_FAILED', error?.message || 'Failed to generate image.');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});