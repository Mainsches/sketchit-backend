export function normalizeText(value = '') {
  return String(value).trim();
}

const VALID_AI_MODES = new Set(['product', 'architect', 'mechanical', 'artist']);

export function normalizeMode(mode) {
  const key = normalizeText(mode).toLowerCase();
  if (VALID_AI_MODES.has(key)) return key;
  return 'product';
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

function buildProductVariationInstruction(_basePrompt = '', variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);

  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }

  return `Create a clearly distinct alternative while preserving the same core object idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Change visible proportions, material treatment, edge language, panel layout emphasis, or leg/support details if compatible with the request.`;
}

export function buildGenerationMode(mode = 'balanced') {
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

function buildArchitectVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct alternative while preserving the same core architectural idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Adjust facade rhythm, glazing pattern, material emphasis, or detail articulation only where compatible with the sketch structure.`;
}

function buildMechanicalVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct engineering alternative while preserving identical functional geometry. Variation index: ${variationIndex}. Variation seed: ${seed}. Change surface finish, parting lines, hardware emphasis, labeling style, or subtle tolerance visualization only—do not alter proportions or topology.`;
}

function buildArtistVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct stylistic interpretation while keeping the same subject identity. Variation index: ${variationIndex}. Variation seed: ${seed}. Explore a different palette, lighting mood, brush or line quality, and compositional emphasis without drifting into an unrelated subject.`;
}

function buildProductSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildProductVariationInstruction(safePrompt, variationIndex);
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

function buildProductTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildProductVariationInstruction(safePrompt, variationIndex);
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

function buildArchitectSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
You are an architect and spatial visualization specialist focused on modern buildings and interiors.

PRIMARY GOAL:
Reconstruct the uploaded sketch into a realistic architectural visualization with maximum structural fidelity to the sketch.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

GEOMETRY PRIORITY RULES:
- The sketch is the main source of truth for massing, circulation, openings, and major planes
- Preserve overall silhouette, proportions, segmentation, and perspective
- Treat sketch lines as meaningful edges for walls, slabs, fenestration, stairs, and built-in volumes where applicable
- Do not redesign the scheme into a different building or generic template
- Do not remove asymmetry or distinctive massing if present

MATERIAL AND ATMOSPHERE RULES:
- Prefer clean, contemporary architectural materials such as concrete, glass, wood, plaster, and steel where appropriate
- Keep materials realistic and physically plausible
- Avoid furniture-product staging logic; this is architectural space and structure, not a product hero shot unless clearly implied

STYLE RULES:
- Architectural realism over decorative fantasy
- Coherent daylighting and spatial depth
- If the sketch is rough, preserve the spatial intention rather than inventing a new layout

RENDER RULES:
- Neutral or minimal context that supports reading the architecture
- Clean visualization lighting suitable for design review
- Realistic scale cues and believable camera height
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
The result must read as a believable modern building or interior that closely matches the uploaded sketch, not a loose reinterpretation.
`;
}

function buildArchitectTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
You are an architect and spatial visualization specialist focused on modern buildings and interiors.

TASK:
Create one realistic architectural visualization from the user's description.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

INTERPRETATION PRIORITY:
- Respect explicit layout, levels, and circulation cues from the user
- Prefer one coherent building or interior scene over unrelated collage elements
- Keep scale, structure, and materials physically plausible

STYLE RULES:
- Architectural realism with clean contemporary material language (concrete, glass, wood, plaster, steel as appropriate)
- Coherent spatial composition and believable lighting

RENDER RULES:
- Neutral or minimal supporting context
- Visualization-quality clarity and depth
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
Deliver a polished architectural image that matches the user's intent and feels spatially convincing.
`;
}

function buildMechanicalSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
You are a senior mechanical engineer and technical visualization expert.

PRIMARY GOAL:
Reconstruct the uploaded sketch into a precise, manufacturable technical object visualization with strict geometry preservation.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

GEOMETRY PRIORITY RULES:
- The sketch is the main source of truth for form, proportions, and feature layout
- Preserve topology, symmetry relationships, holes, bosses, ribs, and parting lines implied by the sketch
- No artistic exaggeration, cartoon proportions, or ornamental redesign
- Do not simplify complex mechanical intent into a generic shape

FUNCTION AND MANUFACTURING RULES:
- The object must read as a functional engineered part or assembly where applicable
- Surfaces should imply real manufacturing processes (machining, casting, sheet forming) without contradicting the sketch
- Keep tolerances visually believable; crisp edges where implied, fillets only where plausible

STYLE RULES:
- Engineering clarity over expressive illustration
- Neutral, objective presentation suitable for design review

RENDER RULES:
- Neutral studio background
- High edge readability and controlled specular highlights
- Photographic realism with CAD-like discipline
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
The result must look like a real manufacturable technical object that closely matches the uploaded sketch, not stylized concept art.
`;
}

function buildMechanicalTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
You are a senior mechanical engineer and technical visualization expert.

TASK:
Create one realistic engineered object visualization from the user's description.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

INTERPRETATION PRIORITY:
- Respect explicit mechanical structure, interfaces, and proportions from the user
- Prefer one coherent part or compact assembly over unrelated objects
- Keep geometry disciplined and manufacturable

STYLE RULES:
- Engineering precision; avoid artistic exaggeration
- Believable materials and finishes for machined or formed parts

RENDER RULES:
- Neutral studio background
- Strong edge definition and readable details
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
Deliver a technically convincing object render aligned with the user's description.
`;
}

function buildArtistSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
You are a concept artist translating sketches into expressive yet faithful finalized imagery.

PRIMARY GOAL:
Reconstruct the uploaded sketch into a stylized, creative image that remains clearly recognizable from the original concept.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

GEOMETRY AND IDENTITY RULES:
- The sketch remains the anchor for subject identity, silhouette, and major relationships
- Preserve the core idea and readable structure; you may enhance clarity without replacing the concept
- More freedom in color harmony, lighting mood, texture language, and compositional emphasis than strict product shots

CREATIVE FREEDOM RULES:
- Expressive rendering is encouraged while staying tied to the sketch
- Avoid drifting into an unrelated subject or generic unrelated artwork
- Stylization should feel intentional and cohesive, not random filters

RENDER RULES:
- Polished illustrative or painterly finish is acceptable if coherent
- Background may support the story but should not overpower the subject
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
The result should feel artistically elevated yet obviously descended from the uploaded sketch.
`;
}

function buildArtistTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
You are a concept artist creating expressive imagery from a written brief.

TASK:
Create one stylized yet coherent image from the user's description.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

INTERPRETATION PRIORITY:
- Honor the user's subject, mood, and key motifs
- Prefer a single strong focal idea over cluttered scenes
- Creative color and composition choices are welcome when they support the brief

STYLE RULES:
- Expressive and art-directed while remaining readable and intentional
- Avoid photoreal product-catalog staging unless explicitly requested

RENDER RULES:
- Visually rich but controlled composition
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE:
Deliver a polished artistic image that matches the user's intent with clear creative voice.
`;
}

export function buildModePrompt({
  mode,
  userPrompt,
  generationMode = 'balanced',
  variationIndex = 0,
  hasSketch = false,
} = {}) {
  const aiMode = normalizeMode(mode);

  if (aiMode === 'product') {
    return hasSketch
      ? buildProductSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildProductTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'architect') {
    return hasSketch
      ? buildArchitectSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildArchitectTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'mechanical') {
    return hasSketch
      ? buildMechanicalSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildMechanicalTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'artist') {
    return hasSketch
      ? buildArtistSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildArtistTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  return hasSketch
    ? buildProductSketchPrompt({ userPrompt, generationMode, variationIndex })
    : buildProductTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
}
