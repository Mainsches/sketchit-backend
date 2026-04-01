import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const MODEL_NAME = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const MEMORY_LIMIT_PER_SESSION = Number(process.env.MEMORY_LIMIT_PER_SESSION || 100);
const MEMORY_LIMIT_TOTAL = Number(process.env.MEMORY_LIMIT_TOTAL || 500);

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * In-memory storage for now.
 *
 * This is intentionally shaped so it can later be moved to Redis/Postgres
 * without changing the API contract too much.
 */
const generationStore = new Map();
const sessionStore = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = 'gen') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function clampString(value = '', maxLength = 4000) {
  return String(value || '').slice(0, maxLength);
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
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
  return findNumberBeforeKeyword(prompt, [
    'shelf',
    'shelves',
    'compartment',
    'compartments',
    'section',
    'sections',
  ]);
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

  const knownColors = [
    'white',
    'black',
    'grey',
    'gray',
    'brown',
    'beige',
    'oak',
    'walnut',
    'green',
    'blue',
    'red',
  ];

  for (const color of knownColors) {
    if (text.includes(color)) {
      colors.push(color);
    }
  }

  return [...new Set(colors)];
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

function buildSketchPrompt({
  userPrompt = '',
  variationSeed = randomSeed(),
  variationIntent = 'base',
}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);

  return `
You are a highly precise industrial CAD designer and product visualization expert.

ABSOLUTE PRIORITY:
The sketch is a strict blueprint. You must replicate it exactly.

This is NOT a creative task.
This is NOT a redesign task.
This is NOT an interpretation.

You are reconstructing the exact object(s) from the sketch into a realistic render.

If the sketch is imperfect, the result must also reflect those imperfections.

TASK:
Convert the sketch into a realistic furniture render WITHOUT changing the design.

OBJECT TYPE:
${furnitureType}

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

VARIATION CONTROL:
- Variation mode: ${variationIntent}
- Variation seed: ${variationSeed}
- If variation mode is not "base", create a distinct result while preserving the same core structure
- Variation may affect material nuance, lighting nuance, camera distance nuance, and styling details only if they do not violate the sketch geometry

CRITICAL GEOMETRY RULES:
- If the sketch contains a full room or scene, you must recreate the SAME scene layout exactly
- Do not rearrange objects
- Do not change camera angle significantly
- Do not simplify the scene
- Do not remove elements
- Every object in the sketch must appear in the final render
- Every line in the sketch represents a real physical edge or surface boundary
- Convert sketch lines directly into 3D geometry
- Preserve ALL angles exactly, including slanted, asymmetrical, or unusual forms
- Preserve ALL proportions exactly
- Preserve the same segmentation and part layout
- DO NOT straighten, align, simplify, or "fix" geometry
- DO NOT smooth edges or corners unless clearly rounded in the sketch
- DO NOT reinterpret rough sketch lines into a new cleaner design

PERSPECTIVE RULE:
- Match the perspective and viewpoint of the sketch as closely as possible
- Do not switch to a more "standard" camera angle

FIDELITY OVERRIDE:
Even if something looks unrealistic, incorrect, or unusual — DO NOT FIX IT.
Reproduce it exactly as seen in the sketch.

STRUCTURE RULES:
- ${countInstruction}
- Every visible panel, door, drawer, section, support, side wall, and divider in the sketch must remain in the final object
- Do not merge segments
- Do not add new segments
- Do not shift spacing
- Count accuracy is critical

ANTI-CREATIVE RULES:
- DO NOT redesign the object
- DO NOT improve the design
- DO NOT make it more aesthetic than the sketch
- DO NOT add missing features based on your assumptions
- DO NOT remove imperfections if they define the structure
- DO NOT use "design intelligence" to reinterpret the object

MATERIAL RULES:
- ${materialInstruction}

COLOR RULES:
- ${colorInstruction}
- Keep color blocking simple and structurally faithful
- If the sketch implies separate panels, maintain those panel color boundaries consistently

REALISM RULES:
- The object must look manufacturable
- Use realistic join logic only if it does not alter the visible shape
- Respect how furniture is actually built without changing the sketch design

RENDER RULES:
- Neutral studio lighting
- Clean neutral background
- Product render style
- No decoration
- No surrounding environment
- High material detail
- Geometry faithfulness is more important than visual beauty

FINAL RULE:
This must look like a real manufactured product that EXACTLY matches the sketch, not an interpretation of it.
`;
}

function buildTextOnlyPrompt({
  userPrompt = '',
  variationSeed = randomSeed(),
  variationIntent = 'base',
}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);

  return `
You are a professional industrial designer and furniture visualization expert.

TASK:
Create a high-quality realistic furniture product render based on the user's text description.

OBJECT TYPE:
${furnitureType}

USER DESCRIPTION:
${safePrompt}

VARIATION CONTROL:
- Variation mode: ${variationIntent}
- Variation seed: ${variationSeed}
- If variation mode is not "base", keep the same core concept but make the result noticeably distinct
- Variation may affect material nuance, proportions within the described concept, framing, and styling while staying realistic and faithful to the user description

STRUCTURE RULES:
- ${countInstruction}
- Respect explicit object counts and segmentation if mentioned
- Do not invent extra doors, drawers, shelves, sections, or supports

MATERIAL RULES:
- ${materialInstruction}

COLOR RULES:
- ${colorInstruction}

DESIGN RULES:
- Create one clear furniture object
- Keep the design minimal, realistic, and premium
- Avoid fantasy or exaggerated shapes
- Avoid decorative clutter
- Use believable proportions
- Make the design visually distinct from previous variants when variation mode is enabled

RENDER RULES:
- Soft studio lighting
- Neutral clean background
- Realistic shadows
- Product photography look
- High material detail
- Clean composition

FINAL INSTRUCTION:
Generate a realistic, clean, minimal furniture product render that fits the user description closely.
`;
}

function buildOpenAiPrompt({ prompt, hasSketch, variationSeed, variationIntent }) {
  if (hasSketch) {
    return buildSketchPrompt({
      userPrompt: prompt,
      variationSeed,
      variationIntent,
    });
  }

  return buildTextOnlyPrompt({
    userPrompt: prompt,
    variationSeed,
    variationIntent,
  });
}

function ensureSession(sessionId) {
  const safeSessionId = normalizeText(sessionId) || createId('session');

  if (!sessionStore.has(safeSessionId)) {
    sessionStore.set(safeSessionId, {
      id: safeSessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      generationIds: [],
    });
  }

  return sessionStore.get(safeSessionId);
}

function sanitizeGenerationForClient(generation) {
  if (!generation) return null;

  return {
    id: generation.id,
    sessionId: generation.sessionId,
    sourceGenerationId: generation.sourceGenerationId,
    type: generation.type,
    status: generation.status,
    prompt: generation.prompt,
    mimeType: generation.mimeType,
    hasSketch: generation.hasSketch,
    imageBase64: generation.imageBase64,
    imageDataUrl: generation.imageBase64
      ? `data:image/png;base64,${generation.imageBase64}`
      : null,
    error: generation.error,
    variationSeed: generation.variationSeed,
    variationIntent: generation.variationIntent,
    meta: generation.meta,
    createdAt: generation.createdAt,
    startedAt: generation.startedAt,
    finishedAt: generation.finishedAt,
  };
}

function pushGenerationToSession(sessionId, generationId) {
  const session = ensureSession(sessionId);
  session.generationIds.push(generationId);
  session.updatedAt = nowIso();

  if (session.generationIds.length > MEMORY_LIMIT_PER_SESSION) {
    const removeCount = session.generationIds.length - MEMORY_LIMIT_PER_SESSION;
    const removedIds = session.generationIds.splice(0, removeCount);

    for (const id of removedIds) {
      generationStore.delete(id);
    }
  }
}

function trimGlobalMemory() {
  if (generationStore.size <= MEMORY_LIMIT_TOTAL) {
    return;
  }

  const entries = [...generationStore.values()].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  while (entries.length > MEMORY_LIMIT_TOTAL) {
    const oldest = entries.shift();
    if (!oldest) break;
    generationStore.delete(oldest.id);

    const session = sessionStore.get(oldest.sessionId);
    if (session) {
      session.generationIds = session.generationIds.filter((id) => id !== oldest.id);
    }
  }
}

async function createImageWithOpenAI({ prompt, imageBase64, mimeType, variationSeed, variationIntent }) {
  const finalPrompt = buildOpenAiPrompt({
    prompt,
    hasSketch: Boolean(imageBase64),
    variationSeed,
    variationIntent,
  });

  console.log('--- SketchIT prompt start ---');
  console.log(finalPrompt);
  console.log('--- SketchIT prompt end ---');

  let result;

  if (imageBase64) {
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    const imageFile = await toFile(
      imageBuffer,
      mimeType === 'image/png' ? 'sketch.png' : 'sketch.jpg',
      { type: mimeType }
    );

    result = await openai.images.edit({
      model: MODEL_NAME,
      image: imageFile,
      prompt: finalPrompt,
      size: IMAGE_SIZE,
    });
  } else {
    result = await openai.images.generate({
      model: MODEL_NAME,
      prompt: finalPrompt,
      size: IMAGE_SIZE,
    });
  }

  const image = result?.data?.[0];

  if (!image?.b64_json) {
    throw new Error('No image returned from OpenAI.');
  }

  return {
    imageBase64: image.b64_json,
    promptUsed: finalPrompt,
  };
}

async function processGeneration(generationId) {
  const generation = generationStore.get(generationId);
  if (!generation) return;

  generation.status = 'processing';
  generation.startedAt = nowIso();
  generation.error = null;

  try {
    const result = await createImageWithOpenAI({
      prompt: generation.prompt,
      imageBase64: generation.inputImageBase64,
      mimeType: generation.mimeType,
      variationSeed: generation.variationSeed,
      variationIntent: generation.variationIntent,
    });

    generation.status = 'done';
    generation.imageBase64 = result.imageBase64;
    generation.meta.promptUsed = result.promptUsed;
    generation.finishedAt = nowIso();
  } catch (error) {
    console.error('FULL ERROR:', error);

    generation.status = 'error';
    generation.error = {
      message: error?.message || 'Unknown server error',
      details: error?.response?.data || null,
    };
    generation.finishedAt = nowIso();
  }
}

function createGenerationRecord({
  sessionId,
  prompt,
  imageBase64,
  mimeType,
  sourceGenerationId = null,
  type = 'base',
  variationIntent = 'base',
}) {
  const generation = {
    id: createId('gen'),
    sessionId,
    sourceGenerationId,
    type,
    status: 'queued',
    prompt: clampString(normalizeText(prompt), 4000),
    mimeType: normalizeText(mimeType) || 'image/jpeg',
    hasSketch: Boolean(imageBase64),
    inputImageBase64: imageBase64 || null,
    imageBase64: null,
    error: null,
    variationSeed: randomSeed(),
    variationIntent,
    meta: {},
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };

  generationStore.set(generation.id, generation);
  pushGenerationToSession(sessionId, generation.id);
  trimGlobalMemory();

  return generation;
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    message: 'SketchIT backend is running',
    model: MODEL_NAME,
    imageSize: IMAGE_SIZE,
    endpoints: [
      'POST /generation/start',
      'GET /generation/:id',
      'POST /generation/:id/variation',
      'GET /session/:sessionId',
    ],
  });
});

app.post('/generation/start', async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mimeType = 'image/jpeg',
      sessionId,
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);

    if (!safePrompt && !imageBase64) {
      return res.status(400).json({
        error: 'Either prompt or imageBase64 is required.',
      });
    }

    const session = ensureSession(sessionId);

    const generation = createGenerationRecord({
      sessionId: session.id,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      type: 'base',
      variationIntent: 'base',
    });

    processGeneration(generation.id).catch((error) => {
      console.error('Background generation crash:', error);
    });

    return res.status(202).json({
      ok: true,
      generation: sanitizeGenerationForClient(generation),
    });
  } catch (error) {
    console.error('START GENERATION ERROR:', error);

    return res.status(500).json({
      error: error?.message || 'Unknown server error',
      details: error?.response?.data || null,
    });
  }
});

app.get('/generation/:id', async (req, res) => {
  const generation = generationStore.get(req.params.id);

  if (!generation) {
    return res.status(404).json({
      error: 'Generation not found.',
    });
  }

  return res.json({
    ok: true,
    generation: sanitizeGenerationForClient(generation),
  });
});

app.post('/generation/:id/variation', async (req, res) => {
  try {
    const sourceGeneration = generationStore.get(req.params.id);

    if (!sourceGeneration) {
      return res.status(404).json({
        error: 'Source generation not found.',
      });
    }

    const {
      prompt,
      variationIntent = 'alternate',
    } = req.body ?? {};

    const variationPrompt = normalizeText(prompt) || sourceGeneration.prompt;

    const variation = createGenerationRecord({
      sessionId: sourceGeneration.sessionId,
      prompt: variationPrompt,
      imageBase64: sourceGeneration.inputImageBase64,
      mimeType: sourceGeneration.mimeType,
      sourceGenerationId: sourceGeneration.id,
      type: 'variation',
      variationIntent,
    });

    processGeneration(variation.id).catch((error) => {
      console.error('Background variation crash:', error);
    });

    return res.status(202).json({
      ok: true,
      generation: sanitizeGenerationForClient(variation),
    });
  } catch (error) {
    console.error('VARIATION ERROR:', error);

    return res.status(500).json({
      error: error?.message || 'Unknown server error',
      details: error?.response?.data || null,
    });
  }
});

app.get('/session/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      error: 'Session not found.',
    });
  }

  const generations = session.generationIds
    .map((id) => generationStore.get(id))
    .filter(Boolean)
    .map((item) => sanitizeGenerationForClient(item));

  return res.json({
    ok: true,
    session: {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      generations,
    },
  });
});

/**
 * Temporary compatibility route so your current frontend does not break instantly.
 *
 * Later we remove this once the app switches to:
 * - POST /generation/start
 * - GET /generation/:id
 */
app.post('/generate', async (req, res) => {
  try {
    const { prompt, imageBase64, mimeType = 'image/jpeg', sessionId } = req.body ?? {};
    const safePrompt = normalizeText(prompt);

    if (!safePrompt && !imageBase64) {
      return res.status(400).json({
        error: 'Either prompt or imageBase64 is required.',
      });
    }

    const session = ensureSession(sessionId);

    const generation = createGenerationRecord({
      sessionId: session.id,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      type: 'base',
      variationIntent: 'base',
    });

    await processGeneration(generation.id);

    const finished = generationStore.get(generation.id);

    if (!finished) {
      return res.status(500).json({
        error: 'Generation disappeared unexpectedly.',
      });
    }

    if (finished.status === 'error') {
      return res.status(500).json({
        error: finished.error?.message || 'Unknown server error',
        details: finished.error?.details || null,
      });
    }

    return res.json({
      imageBase64: finished.imageBase64,
      generationId: finished.id,
      sessionId: finished.sessionId,
    });
  } catch (error) {
    console.error('LEGACY GENERATE ERROR:', error);

    return res.status(500).json({
      error: error?.message || 'Unknown server error',
      details: error?.response?.data || null,
    });
  }
});

app.listen(port, () => {
  console.log(`SketchIT backend running on http://localhost:${port}`);
});
