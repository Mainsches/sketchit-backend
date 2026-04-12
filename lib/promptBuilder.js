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
    return 'Choose neutral, believable product colors that read clearly on a studio backdrop.';
  }

  if (colors.includes('white') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Commit to a white and grey palette that matches the sketch segmentation and reads as premium product photography.';
  }

  if (colors.includes('brown') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Commit to grey and brown tones that lock to the sketch segmentation and material reads.';
  }

  return `Lock the palette to these user-specified colors wherever the sketch supports them: ${colors.join(', ')}.`;
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
    return 'Use realistic glass with structure and mullions driven by the sketch; reflections stay controlled and subordinate to form read.';
  }

  if (material === 'fabric') {
    return 'Use realistic upholstery or textile surfaces exactly where the sketch implies textile zones; keep construction believable and manufacturable.';
  }

  return 'Use neutral realistic furniture materials that read directly from the sketch—no material redesign that changes the form.';
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
    parts.push(`The object must show exactly ${shelfCount} visible shelf/shelves or compartment sections where the sketch implies that segmentation.`);
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

  return `User-requested style cues: ${styles.join(', ')}. Integrate them boldly while keeping sketch geometry locked.`;
}

function extractNegativeHints(prompt = '') {
  const text = prompt.toLowerCase();
  const negatives = [];

  if (text.includes('no handles')) negatives.push('Do not add handles.');
  if (text.includes('without handles')) negatives.push('Do not add handles.');
  if (text.includes('no legs')) negatives.push('Keep legs absent—match the sketch exactly.');
  if (text.includes('wall mounted')) negatives.push('Wall-mounted only—omit floor-standing supports.');
  if (text.includes('floating')) negatives.push('Keep the design visually floating or wall-mounted if implied.');

  return negatives.length ? negatives.join(' ') : 'Do not add unsupported extra details.';
}

function buildProductVariationInstruction(_basePrompt = '', variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);

  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }

  return `Create a clearly distinct alternative while preserving the same core object idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Push different proportions, material treatment, edge language, panel emphasis, or leg/support details—stay inside the same product category and sketch structure.`;
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
  return `Create a clearly distinct alternative while preserving the same core architectural idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Shift facade rhythm, glazing grid, concrete/steel/glass ratios, entrance cut, or environmental staging—massing and sketch read stay locked.`;
}

function buildMechanicalVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct engineering alternative while preserving identical functional geometry. Variation index: ${variationIndex}. Variation seed: ${seed}. Change fastener visibility, surface finish, exploded spacing (subtle), callout emphasis, joint exposure, or labeling—zero topology or proportion drift.`;
}

function buildArtistVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct stylistic interpretation while keeping the same subject identity. Variation index: ${variationIndex}. Variation seed: ${seed}. Swing palette, lighting drama, brush economy, shape exaggeration, and negative space hard—same subject DNA, radically different art read.`;
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
- Rough sketch lines still lock structure—never drift into a prettier redesign

MATERIAL RULES:
- ${materialInstruction}

COLOR RULES:
- ${colorInstruction}

REALISM RULES:
- The result must look manufacturable and shelf-ready
- Furniture construction logic must support the visible design without changing silhouette or segmentation
- Join logic stays clean, tight, and physically convincing

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

FINAL RULE — PRODUCT MODE:
Output must read as a real manufactured product on a studio set: photoreal, commercial, tightly faithful to the uploaded sketch silhouette and segmentation.
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
- Invent zero extra doors, drawers, shelves, or supports beyond what the description implies

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

FINAL RULE — PRODUCT MODE:
Deliver a realistic, clean, catalog-grade product render: the object must look mass-producible and match the user description with zero ambiguity that this is commercial product photography.
`;
}

function buildArchitectSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
You are a lead architect producing competition-grade spatial imagery. You NEVER default to product photography.

ARCHITECT MODE — PRIMARY DIRECTIVE:
Force an architectural reading of the input. Even if the sketch looks like furniture, a vehicle, a gadget, or an abstract doodle, you reinterpret it as architectural inspiration: pavilion, facade fragment, tower slice, interior volume, bridge segment, or sculptural building element scaled for human occupation.

MANDATORY SPATIAL PUSH:
- Scale the design UP into architecture: thick slabs, deep reveals, tall voids, generous glazing, structural depth
- Lock the sketch's silhouette, segmentation, and perspective as the massing diagram—then build concrete, glass, and steel architecture on top of that diagram
- Show real environment: ground plane or floor deck, wall planes, ceiling or sky cut, cast shadows, ambient bounce light, atmospheric depth
- The image must feel like a place you could walk into or around—not an object on seamless white paper

MATERIALS (NON-NEGOTIABLE BIAS):
- Heavy use of board-formed concrete, curtain glass, brushed steel, and restrained warm wood accents where they reinforce structure
- Reject glossy hero-object staging, floating product clichés, and studio cyclorama reads

USER DESCRIPTION (context layer):
${safePrompt || 'No additional description provided—still execute full architectural reinterpretation.'}

SKETCH FIDELITY (STILL LAW):
- The sketch remains the backbone: preserve massing breaks, voids, and major line rhythm
- Do not swap in a generic skyscraper template—architecture must trace the sketch's unique asymmetry and proportions

STYLE AND ATMOSPHERE:
- Push cinematic architectural daylight: strong sun direction, long shadows, specular glass reflections, concrete grain
- Rough sketch energy becomes intentional brutalist or contemporary minimal detailing

RENDER RULES:
- Wide-angle or medium architectural camera height; believable human scale cues (steps, rail, mullion spacing)
- Context beats emptiness: plaza, gallery interior, urban slot, or landscape tie-in
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARCHITECT MODE:
The frame must scream architecture: a spatial concept or built fragment where concrete, glass, and steel dominate, grounded in a real environment with light and shadow—never a product shot.
`;
}

function buildArchitectTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
You are a lead architect visualization director. Product renders are forbidden in this mode.

ARCHITECT MODE — PRIMARY DIRECTIVE:
Whatever the user describes—furniture, vehicle, object, or abstract idea—you translate it into a bold architectural proposition: building, interior sequence, or large-scale spatial object experienced in context.

MANDATORY CONTENT:
- Show structure at architectural scale with concrete, glass, and steel as dominant languages
- Include environment: floor, walls or horizon, sky or ceiling plane, and dramatic natural or gallery lighting with readable shadows
- One coherent scene, spatially deep, occupiable, and photographically believable

USER DESCRIPTION:
${safePrompt || 'No additional description provided—invent a compelling modernist scheme that still feels grounded.'}

COMPOSITION RULES:
- Favor hero spatial moments: atrium cuts, cantilever drama, deep façade relief, long perspective corridors
- Banish seamless white voids unless they read as gallery architecture with visible material junctions

RENDER RULES:
- Visualization polish with real-world lighting complexity
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARCHITECT MODE:
Deliver an image that reads instantly as architectural space or building concept—mass, void, material, and environment first—never as a catalog product.
`;
}

function buildMechanicalSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
You are a principal mechanical engineer + technical illustrator. Beauty marketing is irrelevant here—function reads louder than polish.

MECHANICAL MODE — PRIMARY DIRECTIVE:
Treat the sketch as a mechanical system: parts, interfaces, fasteners, ribs, housings, shafts, brackets, seals, and parting lines are the stars. Push an industrial / engineering documentation aesthetic: almost blueprint, almost shop-floor teardown.

SKETCH FIDELITY (HARD LOCK):
- The sketch drives topology, proportions, holes, symmetry, bosses, slots, and segmentation
- Zero cartoon simplification, zero lifestyle glam, zero soft organic beautification

EXPOSE THE MACHINE:
- Make joints, bolt circles, weld beads, snap features, and wall thickness transitions readable
- Allow a LIGHT exploded-read: subtle axial offsets or ghosted mate lines so relationships read—stay restrained, still one cohesive system
- Raw metals (aluminum, steel, anodize), machined faces, tool marks hints, sharp transitions, functional fillets only

FUNCTION OVER AESTHETICS:
- Prioritize how it works, assembles, and mounts over slick surfacing
- Specular highlights serve legibility, not glamour

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still deliver full mechanical system read.'}

RENDER RULES:
- Cool neutral or industrial gray backdrop; optional faint grid or horizon line for engineering context (keep subtle)
- High-frequency detail, edge-contrast, callout-friendly clarity
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — MECHANICAL MODE:
The image must feel engineered and functional: a believable mechanical assembly or part family with visible structure, joints, and purpose—never a glossy lifestyle product hero.
`;
}

function buildMechanicalTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
You are a principal mechanical engineer visualization lead. Skip consumer glamour entirely.

MECHANICAL MODE — PRIMARY DIRECTIVE:
From the user's words, build one disciplined mechanical system visualization: parts, interfaces, fasteners, and functional surfaces front and center.

MANDATORY ENGINEERING READ:
- Show how components relate: stacked housings, bolted flanges, keyed shafts, cable exits, heat-sink fins, bearing seats—whatever the description implies, make it explicit
- Materials read as machined aluminum, steel, Delrin hints, gasket black, oxide finishes—industrial palette
- Optional subtle exploded spacing or translucent ghost mates to clarify assembly—keep it technical, not theatrical

ANTI-GOALS:
- No soft lifestyle lighting, no perfume-ad reflections, no ambiguous sculptural blobs

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still output a crisp mechanical assembly with believable interfaces.'}

RENDER RULES:
- Neutral industrial environment, razor edge readability, documentary contrast
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — MECHANICAL MODE:
Deliver hardware that looks ready for a design review package: engineered, assembled, and brutally clear about function.
`;
}

function buildArtistSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
You are a senior entertainment concept artist. Photoreal catalog accuracy is NOT the goal—expressive, iconic imagery IS.

ARTIST MODE — PRIMARY DIRECTIVE:
Explode the sketch into stylized concept art: bold shapes, graphic silhouette edits, exaggerated perspective, painterly or inked surfaces, and theatrical lighting. Stay tethered to the sketch's idea and major rhythm, but you MAY abstract, simplify, or amplify masses for emotional impact.

SKETCH ANCHOR (FLEXIBLE BUT REAL):
- Identity comes from the sketch: recognizable subject family, gesture, and compositional spine
- You may stretch proportions, warp perspective, merge planes, or stylize textures for art direction
- Forbidden: drifting into a totally unrelated subject

COLOR AND LIGHT:
- Push saturated or cinematic palettes, rim light, volumetric shafts, neon accents, graphic gradients—color is a storytelling weapon
- Materials can be suggestive rather than physically perfect

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still commit to a loud stylistic take.'}

RENDER RULES:
- Illustration / key-art finish: visible brush economy, line weight, or graphic flat shapes mixed with painterly depth
- Backgrounds participate in the narrative—environmental shapes echo the subject
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARTIST MODE:
The frame must feel expressive and stylized: concept-art energy, exaggerated design language, and creative lighting—clearly not a literal product photo, yet obviously born from the sketch.
`;
}

function buildArtistTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
You are a senior entertainment concept artist pitching a visual development painting.

ARTIST MODE — PRIMARY DIRECTIVE:
Translate the brief into a single bold illustration: stylized forms, exaggerated graphic read, and painterly or inked execution. Literal photorealism is a failure mode here unless the user explicitly demands it.

CREATIVE MANDATE:
- Push abstraction within the subject: amplify silhouettes, play with scale cues, invent color scripts that heighten mood
- Dynamic lighting: rim, bounce color, hard spot, or fantastical sources are encouraged
- Textures can be expressive smears, graphic patterns, or impasto—clarity through art direction, not CAD accuracy

USER DESCRIPTION:
${safePrompt || 'No additional description provided—invent a striking stylistic angle that still respects a single clear subject.'}

GUARDRAILS:
- One focal idea, cohesive style system, zero stock-photo blandness
- Stay on-theme with the user's nouns and mood words

RENDER RULES:
- High-impact composition, cinematic crop, art-first materials
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARTIST MODE:
Deliver a frame that reads as expressive, stylized concept art with creative color and lighting—not a neutral realistic render.
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
