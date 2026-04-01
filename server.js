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
const sessions = new Map();

function normalizeText(value = '') {
  return String(value).trim();
}

function createId(prefix = 'gen') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

  if (text.includes('oak') || text.includes('wood') || text.includes('wooden') || text.includes('walnut') || text.includes('ash wood') || text.includes('grey wood') || text.includes('gray wood')) {
    return 'wood';
  }

  if (text.includes('metal') || text.includes('steel') || text.includes('aluminium') || text.includes('aluminum') || text.includes('iron')) {
    return 'metal';
  }

  if (text.includes('glass') || text.includes('glas')) {
    return 'glass';
  }

  if (text.includes('fabric') || text.includes('textile') || text.includes('upholstered') || text.includes('cushion')) {
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

function buildVariationInstruction(basePrompt = '', variationIndex = 0) {
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

function getOrCreateSession(sessionId) {
  const safeSessionId = sessionId || createId('session');

  if (!sessions.has(safeSessionId)) {
    sessions.set(safeSessionId, {
      id: safeSessionId,
      generationIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return sessions.get(safeSessionId);
}

async function runGeneration({ generationId, prompt, imageBase64, mimeType = 'image/jpeg', generationMode = 'balanced', variationIndex = 0 }) {
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
      const imageFile = await toFile(imageBuffer, mimeType === 'image/png' ? 'sketch.png' : 'sketch.jpg', { type: mimeType });

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
    entry.imageUrl = imageUrl;
    entry.updatedAt = Date.now();
    entry.completedAt = Date.now();
  } catch (error) {
    entry.status = 'error';
    entry.error = error?.message || 'Unknown generation error';
    entry.updatedAt = Date.now();
  }
}

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'SketchIT backend is running' });
});

app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  const items = session.generationIds
    .map((id) => generations.get(id))
    .filter(Boolean);

  return res.json({
    sessionId,
    items,
  });
});

app.get('/generation/:id', (req, res) => {
  const entry = generations.get(req.params.id);

  if (!entry) {
    return res.status(404).json({ error: 'Generation not found.' });
  }

  return res.json(entry);
});

app.post('/generation/start', async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mimeType = 'image/jpeg',
      sessionId,
      generationMode = 'balanced',
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);

    if (!safePrompt && !imageBase64) {
      return res.status(400).json({ error: 'Either prompt or imageBase64 is required.' });
    }

    const generationId = createId('gen');
    const session = getOrCreateSession(sessionId);

    const entry = {
      id: generationId,
      sessionId: session.id,
      prompt: safePrompt,
      type: imageBase64 ? 'sketch' : 'text',
      generationMode,
      imageUrl: null,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      error: null,
      variationOf: null,
      variationIndex: 0,
    };

    generations.set(generationId, entry);
    session.generationIds.push(generationId);
    session.updatedAt = Date.now();

    runGeneration({
      generationId,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      generationMode,
      variationIndex: 0,
    });

    return res.json({
      generationId,
      sessionId: session.id,
      status: 'pending',
      generationMode,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to start generation.' });
  }
});

app.post('/generation/:id/variation', async (req, res) => {
  try {
    const base = generations.get(req.params.id);

    if (!base) {
      return res.status(404).json({ error: 'Base generation not found.' });
    }

    const {
      prompt = base.prompt,
      imageBase64,
      mimeType = 'image/jpeg',
      generationMode = base.generationMode || 'balanced',
    } = req.body ?? {};

    const variationId = createId('gen');
    const session = getOrCreateSession(base.sessionId);
    const siblingCount = session.generationIds
      .map((id) => generations.get(id))
      .filter((item) => item?.variationOf === base.id).length;

    const entry = {
      id: variationId,
      sessionId: session.id,
      prompt: normalizeText(prompt),
      type: imageBase64 || base.type === 'sketch' ? 'sketch' : 'text',
      generationMode,
      imageUrl: null,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      error: null,
      variationOf: base.id,
      variationIndex: siblingCount + 1,
    };

    generations.set(variationId, entry);
    session.generationIds.push(variationId);
    session.updatedAt = Date.now();

    runGeneration({
      generationId: variationId,
      prompt: entry.prompt,
      imageBase64,
      mimeType,
      generationMode,
      variationIndex: entry.variationIndex,
    });

    return res.json({
      generationId: variationId,
      sessionId: session.id,
      status: 'pending',
      generationMode,
      variationOf: base.id,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create variation.' });
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
      return res.status(400).json({ error: 'Either prompt or imageBase64 is required.' });
    }

    const generationId = createId('legacy');
    generations.set(generationId, {
      id: generationId,
      sessionId: null,
      prompt: safePrompt,
      type: imageBase64 ? 'sketch' : 'text',
      generationMode,
      imageUrl: null,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      error: null,
      variationOf: null,
      variationIndex: 0,
    });

    await runGeneration({
      generationId,
      prompt: safePrompt,
      imageBase64,
      mimeType,
      generationMode,
      variationIndex: 0,
    });

    const entry = generations.get(generationId);

    if (entry?.status !== 'done') {
      return res.status(500).json({ error: entry?.error || 'Generation failed.' });
    }

    return res.json({ imageUrl: entry.imageUrl, generationId, generationMode });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to generate image.' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
