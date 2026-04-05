import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

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
    dailyLimit: 2,
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

function normalizeText(value = '') {
  return String(value).trim();
}

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

function textToNumber(value = '') {
  const text = String(value).toLowerCase().trim();

  const map = [
    { patterns: ['one', '1', 'single'], value: 1 },
    { patterns: ['two', '2', 'double'], value: 2 },
    { patterns: ['three', '3'], value: 3 },
    { patterns: ['four', '4'], value: 4 },
    { patterns: ['five', '5'], value: 5 },
    { patterns: ['six', '6'], value: 6 },
  ];

  for (const entry of map) {
    if (entry.patterns.includes(text)) {
      return entry.value;
    }
  }

  return null;
}

function findNumberBeforeKeyword(prompt = '', keywords = []) {
  const text = prompt.toLowerCase();
  const numberWords = '(one|two|three|four|five|six|1|2|3|4|5|6|single|double)';
  const keywordGroup = keywords.join('|');
  const regex = new RegExp(`${numberWords}\\s+(${keywordGroup})`, 'i');
  const match = text.match(regex);

  if (!match) return null;

  return textToNumber(match[1]);
}

function detectDoorCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['door', 'doors']);
}

function detectDrawerCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['drawer', 'drawers']);
}

function detectShelfCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['shelf', 'shelves', 'compartment', 'compartments', 'section', 'sections']);
}

function detectMaterial(prompt = '') {
  const text = prompt.toLowerCase();

  if (
    text.includes('oak') ||
    text.includes('wood') ||
    text.includes('wooden') ||
    text.includes('walnut') ||
    text.includes('ash wood') ||
    text.includes('grey wood') ||
    text.includes('gray wood')
  ) {
    return 'wood';
  }

  if (
    text.includes('metal') ||
    text.includes('steel') ||
    text.includes('aluminium') ||
    text.includes('aluminum') ||
    text.includes('iron')
  ) {
    return 'metal';
  }

  if (text.includes('glass') || text.includes('glas')) {
    return 'glass';
  }

  if (
    text.includes('fabric') ||
    text.includes('textile') ||
    text.includes('upholstered') ||
    text.includes('cushion')
  ) {
    return 'fabric';
  }

  return 'neutral';
}

function detectColors(prompt = '') {
  const text = prompt.toLowerCase();
  const colors = [];
  const knownColors = ['white', 'black', 'grey', 'gray', 'brown', 'beige', 'oak', 'walnut', 'green', 'blue', 'red'];

  for (const color of knownColors) {
    if (text.includes(color)) {
      colors.push(color);
    }
  }

  return [...new Set(colors)];
}

function detectStyleHints(prompt = '') {
  const text = prompt.toLowerCase();
  const styles = [];

  if (text.includes('minimal')) styles.push('minimal');
  if (text.includes('modern')) styles.push('modern');
  if (text.includes('scandinavian')) styles.push('scandinavian');
  if (text.includes('industrial')) styles.push('industrial');
  if (text.includes('premium') || text.includes('luxury')) styles.push('premium');

  return styles;
}

function detectFurnitureType(prompt = '') {
  const text = prompt.toLowerCase();

  if (text.includes('chair')) return 'chair';
  if (text.includes('table')) return 'table';
  if (text.includes('cabinet')) return 'cabinet';
  if (text.includes('closet')) return 'closet';
  if (text.includes('wardrobe')) return 'wardrobe';
  if (text.includes('shelf')) return 'shelf';
  if (text.includes('sideboard')) return 'sideboard';
  if (text.includes('stool')) return 'stool';
  if (text.includes('bench')) return 'bench';
  if (text.includes('desk')) return 'desk';

  return 'general furniture object';
}

function buildColorInstruction(colors = []) {
  if (!colors.length) {
    return 'Use neutral believable colors only if appropriate for the object and material.';
  }

  if (colors.includes('white') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Use a white and grey color combination, applied in a believable way that fits the sketch.';
  }

  if (colors.includes('brown') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Use a grey and brown color combination, applied in a believable way that matches the visible segmentation.';
  }

  return `Use these colors only if supported by the sketch and user description: ${colors.join(', ')}.`;
}

function buildMaterialInstruction(material, prompt = '') {
  const text = prompt.toLowerCase();

  if (material === 'wood') {
    if (text.includes('grey wood') || text.includes('gray wood')) {
      return 'Use realistic grey wood as the main material and preserve a believable wood texture.';
    }
    if (text.includes('oak')) {
      return 'Use realistic oak wood as the main material with believable grain and a premium furniture finish.';
    }
    if (text.includes('walnut')) {
      return 'Use realistic walnut wood as the main material with rich natural grain and a premium finish.';
    }
    return 'Use realistic wood as the main material with believable grain, clean edges, and a manufacturable finish.';
  }

  if (material === 'metal') {
    return 'Use realistic metal surfaces with believable reflections, clean joins, and a manufacturable furniture finish.';
  }

  if (material === 'glass') {
    return 'Use realistic glass surfaces combined with plausible supporting furniture structure and subtle reflections.';
  }

  if (material === 'fabric') {
    return 'Use realistic upholstery or textile surfaces only where clearly implied, with believable furniture construction.';
  }

  return 'Use neutral realistic furniture materials that fit the sketch naturally without redesigning the object.';
}

function buildCountInstruction(prompt = '') {
  const doorCount = detectDoorCount(prompt);
  const drawerCount = detectDrawerCount(prompt);
  const shelfCount = detectShelfCount(prompt);
  const parts = [];

  if (doorCount) {
    parts.push(`The object must have exactly ${doorCount} visible door${doorCount > 1 ? 's' : ''}.`);
  }
  if (drawerCount) {
    parts.push(`The object must have exactly ${drawerCount} visible drawer${drawerCount > 1 ? 's' : ''}.`);
  }
  if (shelfCount) {
    parts.push(`The object must have exactly ${shelfCount} visible shelf/shelves or compartment sections if clearly implied by the design.`);
  }

  if (!parts.length) {
    return 'Preserve the visible structural segmentation from the sketch exactly. Do not invent extra doors, drawers, or compartments.';
  }

  return parts.join(' ');
}

function buildStyleInstruction(prompt = '') {
  const styles = detectStyleHints(prompt);

  if (!styles.length) {
    return 'Keep the design clean, believable, and commercially realistic.';
  }

  return `Style direction from the user: ${styles.join(', ')}. Apply only if it does not conflict with the sketch structure.`;
}

function extractNegativeHints(prompt = '') {
  const text = prompt.toLowerCase();
  const negatives = [];

  if (text.includes('no handles')) negatives.push('Do not add handles.');
  if (text.includes('without handles')) negatives.push('Do not add handles.');
  if (text.includes('no legs')) negatives.push('Do not add visible legs unless clearly present.');
  if (text.includes('wall mounted')) negatives.push('Do not add floor-standing support unless clearly present.');
  if (text.includes('floating')) negatives.push('Keep the design visually floating or wall-mounted if implied.');

  return negatives.length ? negatives.join(' ') : 'Do not add unsupported extra details.';
}

function buildVariationInstruction(_basePrompt = '', variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);

  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }

  return `Create a clearly distinct alternative while preserving the same core object idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Change visible proportions, material treatment, edge language, panel layout emphasis, or leg/support details if compatible with the request.`;
}

function buildGenerationMode(mode = 'balanced') {
  if (mode === 'fast') {
    return {
      label: 'fast',
      renderInstruction: 'Prioritize a clean result and low latency. Keep composition simple and direct.',
      apiSize: '1024x1024',
    };
  }

  if (mode === 'premium') {
    return {
      label: 'premium',
      renderInstruction: 'Prioritize richer material detail and a stronger premium product-photography feel.',
      apiSize: '1024x1024',
    };
  }

  return {
    label: 'balanced',
    renderInstruction: 'Balance speed, cost, and visual quality. Keep the result clean and commercially polished.',
    apiSize: '1024x1024',
  };
}

function buildSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildVariationInstruction(safePrompt, variationIndex);
  const mode = buildGenerationMode(generationMode);

  return `
You are a highly precise industrial designer, furniture engineer, and product visualization expert.

PRIMARY GOAL:
Reconstruct the uploaded sketch into a realistic product render with maximum structural fidelity.

TASK TYPE:
Sketch-to-image reconstruction for a ${furnitureType}.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

GEOMETRY PRIORITY RULES:
- The sketch is the main source of truth
- Preserve the same overall silhouette, proportions, segmentation, and perspective
- Every visible line likely represents a meaningful physical edge, panel split, or boundary
- Do not redesign the object
- Do not simplify unusual shapes
- Do not remove asymmetry if present
- Do not replace the concept with a more generic furniture design

COUNT AND STRUCTURE RULES:
- ${countInstruction}
- Preserve visible panels, dividers, side walls, supports, and openings
- Do not invent extra compartments or decorative elements

STYLE RULES:
- ${styleInstruction}
- ${negativeHints}
- If the sketch is rough, preserve the structural intention instead of beautifying it into a different design

MATERIAL RULES:
- ${materialInstruction}

COLOR RULES:
- ${colorInstruction}

REALISM RULES:
- The result must look manufacturable
- Use believable furniture construction logic only if it does not alter the visible design
- Keep join logic clean and realistic

RENDER RULES:
- Neutral background
- Product render / product photo look
- Soft controlled studio lighting
- Clean composition
- Strong edge readability
- Realistic materials
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
This must look like a real manufactured product that closely matches the uploaded sketch, not a loose interpretation.
`;
}

function buildTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildVariationInstruction(safePrompt, variationIndex);
  const mode = buildGenerationMode(generationMode);

  return `
You are a professional industrial designer and product visualization expert.

TASK:
Create one realistic furniture product render from the user's description.

OBJECT TYPE:
${furnitureType}

USER DESCRIPTION:
${safePrompt}

INTERPRETATION PRIORITY:
- Respect the user's explicit structure and layout instructions
- Prefer one strong, coherent object over multiple objects
- Keep the object manufacturable and believable

STRUCTURE RULES:
- ${countInstruction}
- Do not invent extra doors, drawers, shelves, or supports unless clearly implied

STYLE RULES:
- ${styleInstruction}
- ${negativeHints}
- Keep the design commercially realistic, clean, and premium

MATERIAL RULES:
- ${materialInstruction}

COLOR RULES:
- ${colorInstruction}

RENDER RULES:
- Product photography style
- Neutral clean background
- Soft studio lighting
- Realistic shadows
- High edge clarity
- Clean composition
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
Generate a realistic, clean, minimal product render that follows the user description closely and looks production-ready.
`;
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

function validateUsageForGeneration(session, generationMode, isVariation = false) {
  const usage = getUsagePayload(session);

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

  if (usage.remainingToStart <= 0) {
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

function registerGenerationStart(session) {
  const usage = ensureUserUsage(session);
  usage.pendingCount += 1;
  session.updatedAt = Date.now();
  return getUsagePayload(session);
}

function finalizeGenerationUsage(userKey, success) {
  const session = userSessions.get(userKey);
  if (!session) return null;

  const usage = ensureUserUsage(session);
  usage.pendingCount = Math.max(0, usage.pendingCount - 1);

  if (success) {
    usage.dailyCount += 1;
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
}) {
  const entry = generations.get(generationId);
  if (!entry) return;

  try {
    entry.status = 'processing';
    entry.updatedAt = Date.now();

    let result;
    const mode = buildGenerationMode(generationMode);

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
        prompt: buildSketchPrompt({ userPrompt: prompt, generationMode, variationIndex }),
        size: mode.apiSize,
      });
    } else {
      result = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: buildTextOnlyPrompt({ userPrompt: prompt, generationMode, variationIndex }),
        size: mode.apiSize,
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

    const usage = finalizeGenerationUsage(userKey, true);
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

    const usage = finalizeGenerationUsage(userKey, false);
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
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);

    if (!safePrompt && !imageBase64) {
      return jsonError(res, 400, 'INVALID_INPUT', 'Either prompt or imageBase64 is required.');
    }

    const session = getOrCreateUserSession({ sessionId, deviceId });
    const access = validateUsageForGeneration(session, generationMode, false);

    if (!access.allowed) {
      return jsonError(res, access.status, access.code, access.message, { usage: access.usage });
    }

    const usage = registerGenerationStart(session);
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
      status: 'pending',
      error: null,
      variationSeed: null,
      variationIntent: null,
      meta: {
        promptUsed: safePrompt,
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
    } = req.body ?? {};

    const access = validateUsageForGeneration(session, generationMode, true);

    if (!access.allowed) {
      return jsonError(res, access.status, access.code, access.message, { usage: access.usage });
    }

    const usage = registerGenerationStart(session);
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
      status: 'pending',
      error: null,
      variationSeed: Math.floor(Math.random() * 1000000),
      variationIntent,
      meta: {
        promptUsed: normalizeText(prompt),
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
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);

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
      status: 'pending',
      error: null,
      meta: {
        promptUsed: safePrompt,
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