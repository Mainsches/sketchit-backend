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

function normalizeText(value = '') {
  return String(value).trim();
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

function buildSketchPrompt(userPrompt = '') {
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
The sketch is the ONLY source of truth. Accuracy is more important than beauty.

TASK:
Convert the sketch into a realistic furniture render WITHOUT changing the design.

OBJECT TYPE:
${furnitureType}

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

CRITICAL GEOMETRY RULES:
- Every line in the sketch represents a real physical edge or surface boundary
- Convert sketch lines directly into 3D geometry
- Preserve ALL angles exactly, including slanted, asymmetrical, or unusual forms
- Preserve ALL proportions exactly
- Preserve the same segmentation and part layout
- DO NOT straighten, align, simplify, or "fix" geometry
- DO NOT smooth edges or corners unless clearly rounded in the sketch
- DO NOT reinterpret rough sketch lines into a new cleaner design

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

function buildTextOnlyPrompt(userPrompt = '') {
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

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'SketchIT backend is running' });
});

app.post('/generate', async (req, res) => {
  try {
    const {
      prompt,
      imageBase64,
      mimeType = 'image/jpeg',
    } = req.body ?? {};

    const safePrompt = normalizeText(prompt);

    if (!safePrompt && !imageBase64) {
      return res.status(400).json({
        error: 'Either prompt or imageBase64 is required.',
      });
    }

    let result;

    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(cleanBase64, 'base64');

      const imageFile = await toFile(
        imageBuffer,
        mimeType === 'image/png' ? 'sketch.png' : 'sketch.jpg',
        { type: mimeType }
      );

      const finalPrompt = buildSketchPrompt(safePrompt);

      console.log('Using sketch-based prompt...');
      console.log(finalPrompt);

      result = await openai.images.edit({
        model: 'gpt-image-1',
        image: imageFile,
        prompt: finalPrompt,
        size: '1024x1024',
      });
    } else {
      const finalPrompt = buildTextOnlyPrompt(safePrompt);

      console.log('Using text-only prompt...');
      console.log(finalPrompt);

      result = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: finalPrompt,
        size: '1024x1024',
      });
    }

    const image = result?.data?.[0];

    if (!image || !image.b64_json) {
      return res.status(500).json({
        error: 'No image returned from OpenAI.',
        debugKeys: Object.keys(result || {}),
      });
    }

    res.json({
      imageBase64: image.b64_json,
    });
  } catch (error) {
    console.error('FULL ERROR:', error);

    res.status(500).json({
      error: error?.message || 'Unknown server error',
      details: error?.response?.data || null,
    });
  }
});

app.listen(port, () => {
  console.log(`SketchIT backend running on http://localhost:${port}`);
});